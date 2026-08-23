import type { ConversationData, Message, MessagePart, RawConversationPayload } from '@/utils/types';
import { CLAUDE_UUID_PATTERN, parseClaudeConversationApiUrl } from './request';

type ClaudeContentBlock = Record<string, unknown> & { type: string };

type ClaudeMessagePayload = {
    uuid: string;
    parent_message_uuid: string | null;
    sender: 'human' | 'assistant';
    content: ClaudeContentBlock[];
    truncated: boolean;
    stop_reason?: string | null;
    created_at: string;
    updated_at: string;
};

type ClaudeConversationPayload = Record<string, unknown> & {
    uuid: string;
    name: string;
    summary: string;
    created_at: string;
    updated_at: string;
    current_leaf_message_uuid: string;
    model: string;
    chat_messages: ClaudeMessagePayload[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const parseTimestamp = (value: string): number | null => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? milliseconds / 1000 : null;
};

const isClaudeContentBlock = (value: unknown): value is ClaudeContentBlock =>
    isRecord(value) && typeof value.type === 'string' && value.type.length > 0;

const isClaudeStopReason = (value: unknown): value is string | null | undefined =>
    value === undefined || value === null || typeof value === 'string';

const isClaudeMessagePayload = (value: unknown): value is ClaudeMessagePayload => {
    if (!isRecord(value)) {
        return false;
    }
    if (!CLAUDE_UUID_PATTERN.test(typeof value.uuid === 'string' ? value.uuid : '')) {
        return false;
    }
    if (value.sender !== 'human' && value.sender !== 'assistant') {
        return false;
    }
    if (
        value.parent_message_uuid !== null &&
        !CLAUDE_UUID_PATTERN.test(typeof value.parent_message_uuid === 'string' ? value.parent_message_uuid : '')
    ) {
        return false;
    }
    if (!Array.isArray(value.content) || !value.content.every(isClaudeContentBlock)) {
        return false;
    }
    if (typeof value.truncated !== 'boolean') {
        return false;
    }
    if (!isClaudeStopReason(value.stop_reason)) {
        return false;
    }
    return (
        typeof value.created_at === 'string' &&
        parseTimestamp(value.created_at) !== null &&
        typeof value.updated_at === 'string' &&
        parseTimestamp(value.updated_at) !== null
    );
};

export const isClaudeConversationPayload = (payload: unknown): payload is ClaudeConversationPayload => {
    if (!isRecord(payload)) {
        return false;
    }
    if (!CLAUDE_UUID_PATTERN.test(typeof payload.uuid === 'string' ? payload.uuid : '')) {
        return false;
    }
    if (
        typeof payload.current_leaf_message_uuid !== 'string' ||
        !CLAUDE_UUID_PATTERN.test(payload.current_leaf_message_uuid)
    ) {
        return false;
    }
    if (
        typeof payload.name !== 'string' ||
        typeof payload.summary !== 'string' ||
        typeof payload.model !== 'string' ||
        typeof payload.created_at !== 'string' ||
        parseTimestamp(payload.created_at) === null ||
        typeof payload.updated_at !== 'string' ||
        parseTimestamp(payload.updated_at) === null
    ) {
        return false;
    }
    if (!Array.isArray(payload.chat_messages) || payload.chat_messages.length === 0) {
        return false;
    }
    if (!payload.chat_messages.every(isClaudeMessagePayload)) {
        return false;
    }

    const messageIds = new Set(payload.chat_messages.map((message) => message.uuid));
    return messageIds.size === payload.chat_messages.length && messageIds.has(payload.current_leaf_message_uuid);
};

const extractTextBlocks = (content: ClaudeContentBlock[]): string =>
    content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('\n')
        .trim()
        .normalize('NFC');

const resolveMessageStatus = (message: ClaudeMessagePayload): Message['status'] => {
    if (message.truncated) {
        return 'error';
    }
    if (message.sender === 'human' || message.stop_reason === 'end_turn') {
        return 'finished_successfully';
    }
    return 'in_progress';
};

const buildMessage = (message: ClaudeMessagePayload): Message => {
    const text = extractTextBlocks(message.content);
    const contentTypes = message.content.map((block) => block.type);
    const isTextOnly = contentTypes.length > 0 && contentTypes.every((type) => type === 'text');
    const createTime = parseTimestamp(message.created_at);
    const updateTime = parseTimestamp(message.updated_at);
    const isAssistantEndTurn =
        message.sender === 'assistant' && message.stop_reason === 'end_turn' && !message.truncated;

    return {
        id: message.uuid,
        author: {
            role: message.sender === 'human' ? 'user' : 'assistant',
            name: message.sender === 'human' ? 'User' : 'Claude',
            metadata: {},
        },
        create_time: createTime,
        update_time: updateTime,
        content: {
            content_type: isTextOnly ? 'text' : 'multimodal_text',
            parts: message.content as MessagePart[],
            content: text,
        },
        status: resolveMessageStatus(message),
        end_turn: message.sender === 'human' ? true : isAssistantEndTurn,
        weight: 1,
        metadata: {
            claude_sender: message.sender,
            claude_stop_reason: message.stop_reason ?? null,
            claude_truncated: message.truncated,
            claude_parent_message_uuid: message.parent_message_uuid,
            claude_content_types: contentTypes,
        },
        recipient: 'all',
        channel: null,
    };
};

export const parseClaudeConversationPayload = (payload: unknown, requestUrl: string): ConversationData | null => {
    const apiContext = parseClaudeConversationApiUrl(requestUrl);
    if (!apiContext || !isClaudeConversationPayload(payload) || apiContext.conversationId !== payload.uuid) {
        return null;
    }

    const messageIds = new Set(payload.chat_messages.map((message) => message.uuid));
    const mapping: ConversationData['mapping'] = {};
    for (const rawMessage of payload.chat_messages) {
        const parent = rawMessage.parent_message_uuid;
        mapping[rawMessage.uuid] = {
            id: rawMessage.uuid,
            message: buildMessage(rawMessage),
            parent: parent && messageIds.has(parent) ? parent : null,
            children: [],
        };
    }
    for (const node of Object.values(mapping)) {
        if (node.parent && mapping[node.parent]) {
            mapping[node.parent]!.children.push(node.id);
        }
    }

    const createTime = parseTimestamp(payload.created_at);
    const updateTime = parseTimestamp(payload.updated_at);
    if (createTime === null || updateTime === null) {
        return null;
    }

    const title = payload.name.trim() || payload.summary.trim() || 'Claude Conversation';
    return {
        title,
        create_time: createTime,
        update_time: updateTime,
        mapping,
        conversation_id: payload.uuid,
        current_node: payload.current_leaf_message_uuid,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: payload.model || 'claude',
        safe_urls: [],
        blocked_urls: [],
        raw_payload: payload as RawConversationPayload,
    };
};

export const parseClaudeInterceptedData = (data: string, requestUrl: string): ConversationData | null => {
    try {
        return parseClaudeConversationPayload(JSON.parse(data), requestUrl);
    } catch {
        return null;
    }
};
