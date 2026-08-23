import type { ConversationData, Message, MessageContent, MessageNode, RawConversationPayload } from '@/utils/types';

import { DEEPSEEK_CONVERSATION_ID_PATTERN, parseDeepSeekHistoryRequestContext } from './request';

type JsonRecord = Record<string, unknown>;

type DeepSeekFragment = {
    type: string;
    content?: string;
};

type DeepSeekMessage = {
    messageId: string;
    parentId: string | null;
    role: 'system' | 'user' | 'assistant' | 'tool';
    insertedAt: number | null;
    model: string | null;
    status: string;
    fragments: DeepSeekFragment[];
    autoContinue: boolean | null;
    hasPendingFragment: boolean | null;
    incompleteMessageIsNull: boolean;
};

type DeepSeekSession = {
    id: string;
    title: string;
    currentMessageId: string;
    insertedAt: number;
    updatedAt: number;
    model: string;
};

type DeepSeekHistoryEnvelope = {
    rawPayload: RawConversationPayload;
    session: DeepSeekSession;
    messages: DeepSeekMessage[];
};

const isRecord = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value);

const asStringId = (value: unknown): string | null => {
    if (typeof value === 'string' && value.trim().length > 0) {
        return value;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
        return `${value}`;
    }
    return null;
};

const asTimestamp = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const parseRole = (value: unknown): DeepSeekMessage['role'] | null => {
    if (value === 'USER') {
        return 'user';
    }
    if (value === 'ASSISTANT') {
        return 'assistant';
    }
    if (value === 'SYSTEM') {
        return 'system';
    }
    if (value === 'TOOL') {
        return 'tool';
    }
    return null;
};

const parseFragments = (value: unknown): DeepSeekFragment[] | null => {
    if (!Array.isArray(value)) {
        return null;
    }

    const fragments: DeepSeekFragment[] = [];
    for (const candidate of value) {
        if (!isRecord(candidate) || typeof candidate.type !== 'string') {
            return null;
        }
        fragments.push({
            type: candidate.type,
            ...(typeof candidate.content === 'string' ? { content: candidate.content } : {}),
        });
    }
    return fragments;
};

const parseMessage = (value: unknown): DeepSeekMessage | null => {
    if (!isRecord(value)) {
        return null;
    }
    const messageId = asStringId(value.message_id);
    const parentId = asStringId(value.parent_id);
    const role = parseRole(value.role);
    const fragments = parseFragments(value.fragments);
    if (!messageId || !role || !fragments || typeof value.status !== 'string') {
        return null;
    }

    return {
        messageId,
        parentId,
        role,
        insertedAt: asTimestamp(value.inserted_at),
        model: typeof value.model === 'string' && value.model.trim() ? value.model : null,
        status: value.status,
        fragments,
        autoContinue: typeof value.auto_continue === 'boolean' ? value.auto_continue : null,
        hasPendingFragment: typeof value.has_pending_fragment === 'boolean' ? value.has_pending_fragment : null,
        incompleteMessageIsNull: value.incomplete_message === null,
    };
};

const parseSession = (value: unknown): DeepSeekSession | null => {
    if (!isRecord(value)) {
        return null;
    }
    const id = asStringId(value.id);
    const currentMessageId = asStringId(value.current_message_id);
    const insertedAt = asTimestamp(value.inserted_at);
    const updatedAt = asTimestamp(value.updated_at);
    if (
        !id ||
        !DEEPSEEK_CONVERSATION_ID_PATTERN.test(id) ||
        !currentMessageId ||
        insertedAt === null ||
        updatedAt === null ||
        value.is_empty !== false
    ) {
        return null;
    }

    return {
        id,
        title: typeof value.title === 'string' ? value.title : '',
        currentMessageId,
        insertedAt,
        updatedAt,
        model: typeof value.model_type === 'string' && value.model_type.trim() ? value.model_type : 'deepseek',
    };
};

const hasValidDeepSeekMessageGraph = (messages: DeepSeekMessage[], currentMessageId: string): boolean => {
    const roots = messages.filter((message) => message.parentId === '0');
    if (roots.length !== 1) {
        return false;
    }

    const childrenById = new Map(messages.map((message) => [message.messageId, [] as string[]]));
    for (const message of messages) {
        if (message.parentId === null || message.parentId === message.messageId) {
            return false;
        }
        if (message.parentId !== '0') {
            const siblings = childrenById.get(message.parentId);
            if (!siblings) {
                return false;
            }
            siblings.push(message.messageId);
        }
    }
    if ((childrenById.get(currentMessageId)?.length ?? 0) > 0) {
        return false;
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (messageId: string): boolean => {
        if (visiting.has(messageId)) {
            return false;
        }
        if (visited.has(messageId)) {
            return true;
        }
        visiting.add(messageId);
        for (const childId of childrenById.get(messageId) ?? []) {
            if (!visit(childId)) {
                return false;
            }
        }
        visiting.delete(messageId);
        visited.add(messageId);
        return true;
    };

    return visit(roots[0]!.messageId) && visited.size === messages.length && visited.has(currentMessageId);
};

const parseEnvelope = (value: unknown): DeepSeekHistoryEnvelope | null => {
    if (!isRecord(value) || value.code !== 0 || !isRecord(value.data) || value.data.biz_code !== 0) {
        return null;
    }
    const bizData = value.data.biz_data;
    if (!isRecord(bizData)) {
        return null;
    }

    const session = parseSession(bizData.chat_session);
    if (!session || !Array.isArray(bizData.chat_messages) || bizData.chat_messages.length === 0) {
        return null;
    }
    const messages: DeepSeekMessage[] = [];
    const seenIds = new Set<string>();
    for (const candidate of bizData.chat_messages) {
        const parsed = parseMessage(candidate);
        if (!parsed || seenIds.has(parsed.messageId)) {
            return null;
        }
        seenIds.add(parsed.messageId);
        messages.push(parsed);
    }
    if (!seenIds.has(session.currentMessageId) || !hasValidDeepSeekMessageGraph(messages, session.currentMessageId)) {
        return null;
    }

    return {
        rawPayload: value as RawConversationPayload,
        session,
        messages,
    };
};

const isProviderMessageTerminal = (message: DeepSeekMessage) =>
    message.status === 'FINISHED' &&
    message.hasPendingFragment === false &&
    message.incompleteMessageIsNull &&
    message.autoContinue === false;

const extractFragmentText = (message: DeepSeekMessage, type: string) =>
    message.fragments
        .filter((fragment) => fragment.type === type && typeof fragment.content === 'string')
        .map((fragment) => fragment.content!)
        .join('\n\n');

const buildMessageContent = (message: DeepSeekMessage, terminal: boolean): MessageContent => {
    const responseType = message.role === 'user' ? 'REQUEST' : 'RESPONSE';
    const text = extractFragmentText(message, responseType);
    const thoughts = message.fragments
        .filter((fragment) => fragment.type === 'THINK' && typeof fragment.content === 'string')
        .map((fragment) => ({
            summary: 'Reasoning',
            content: fragment.content!,
            chunks: [],
            finished: terminal,
        }));

    return {
        content_type: thoughts.length > 0 ? 'thoughts' : 'text',
        parts: [text],
        ...(thoughts.length > 0 ? { thoughts } : {}),
    };
};

const buildNormalizedMessage = (message: DeepSeekMessage): Message => {
    const terminal = isProviderMessageTerminal(message);
    return {
        id: message.messageId,
        author: {
            role: message.role,
            name: message.role === 'assistant' ? 'DeepSeek' : message.role === 'user' ? 'User' : null,
            metadata: {},
        },
        create_time: message.insertedAt,
        update_time: message.insertedAt,
        content: buildMessageContent(message, terminal),
        status: terminal ? 'finished_successfully' : 'in_progress',
        end_turn: terminal,
        weight: 1,
        metadata: {
            providerStatus: message.status,
            model: message.model,
            fragmentTypes: message.fragments.map((fragment) => fragment.type),
            autoContinue: message.autoContinue,
            hasPendingFragment: message.hasPendingFragment,
            incompleteMessagePresent: !message.incompleteMessageIsNull,
        },
        recipient: 'all',
        channel: null,
    };
};

const buildMapping = (conversationId: string, messages: DeepSeekMessage[]) => {
    const rootId = `deepseek-root-${conversationId}`;
    const mapping: Record<string, MessageNode> = {
        [rootId]: { id: rootId, message: null, parent: null, children: [] },
    };
    for (const message of messages) {
        const parent = message.parentId === '0' ? rootId : message.parentId;
        mapping[message.messageId] = {
            id: message.messageId,
            message: buildNormalizedMessage(message),
            parent,
            children: [],
        };
    }

    for (const message of messages) {
        const parent = mapping[message.messageId]?.parent;
        if (parent && mapping[parent]) {
            mapping[parent].children.push(message.messageId);
        }
    }
    return mapping;
};

export const isDeepSeekHistoryPayload = (value: unknown): boolean => parseEnvelope(value) !== null;

export const parseDeepSeekHistoryResponse = (data: string, url: string): ConversationData | null => {
    const requestContext = parseDeepSeekHistoryRequestContext(url);
    if (!requestContext) {
        return null;
    }

    let payload: unknown;
    try {
        payload = JSON.parse(data);
    } catch {
        return null;
    }

    const envelope = parseEnvelope(payload);
    if (!envelope || envelope.session.id !== requestContext.conversationId) {
        return null;
    }

    const mapping = buildMapping(envelope.session.id, envelope.messages);
    const currentMessage = envelope.messages.find((message) => message.messageId === envelope.session.currentMessageId);
    const model = currentMessage?.model ?? envelope.session.model;
    return {
        title: envelope.session.title,
        create_time: envelope.session.insertedAt,
        update_time: envelope.session.updatedAt,
        mapping,
        conversation_id: envelope.session.id,
        current_node: envelope.session.currentMessageId,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: model,
        safe_urls: [],
        blocked_urls: [],
        raw_payload: envelope.rawPayload,
    };
};
