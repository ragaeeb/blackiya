import type {
    ConversationData,
    Message,
    MessageContent,
    MessageNode,
    MessagePart,
    RawConversationPayload,
} from '@/utils/types';
import { NOVA_CONVERSATION_ID_PATTERN } from './constants';

type JsonRecord = Record<string, unknown>;
type NovaMessageStatus = Message['status'];

const TERMINAL_STATUSES = new Set(['complete', 'completed', 'done', 'finished', 'succeeded', 'success']);
const TRANSIENT_STATUSES = new Set(['in_progress', 'pending', 'running', 'streaming']);
const ERROR_STATUSES = new Set(['aborted', 'cancelled', 'error', 'failed', 'failure']);
const STRUCTURED_CONTENT_KEYS = [
    'a2uiMessage',
    'agentLifecycle',
    'agentToolStep',
    'artifact',
    'citation',
    'files',
    'reasoningBlocks',
    'toolFriendlyMessage',
    'toolResult',
    'toolUse',
] as const;

const toRecord = (value: unknown): JsonRecord | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;

const nonEmptyString = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value : null;

const firstNonEmptyString = (...values: unknown[]): string | null => {
    for (const value of values) {
        const resolved = nonEmptyString(value);
        if (resolved) {
            return resolved;
        }
    }
    return null;
};

const normalizeStatus = (value: unknown): string | null => nonEmptyString(value)?.trim().toLowerCase() ?? null;

const classifyStatus = (messageStatus: unknown, interaction: JsonRecord): NovaMessageStatus => {
    const message = normalizeStatus(messageStatus);
    const interactionStatus = normalizeStatus(interaction.status);
    const deepResearchStatus = normalizeStatus(interaction.deepResearchStatus);
    const statuses = [message, interactionStatus, deepResearchStatus].filter((status): status is string => !!status);

    if (statuses.some((status) => ERROR_STATUSES.has(status))) {
        return 'error';
    }
    if (statuses.some((status) => TRANSIENT_STATUSES.has(status))) {
        return 'in_progress';
    }
    if (statuses.length > 0 && statuses.every((status) => TERMINAL_STATUSES.has(status))) {
        return 'finished_successfully';
    }
    return 'in_progress';
};

const parseTimestamp = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 100_000_000_000 ? value / 1000 : value;
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
        return null;
    }
    const milliseconds = Date.parse(value);
    return Number.isNaN(milliseconds) ? null : milliseconds / 1000;
};

const resolveRole = (value: unknown): Message['author']['role'] | null => {
    const role = normalizeStatus(value);
    if (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') {
        return role;
    }
    return null;
};

const hasStructuredContent = (content: JsonRecord) =>
    STRUCTURED_CONTENT_KEYS.some((key) => content[key] !== null && content[key] !== undefined);

type ParsedContentEntry = {
    parts: MessagePart[];
    hasStructured: boolean;
};

const parseContentEntry = (entry: unknown): ParsedContentEntry | null => {
    if (typeof entry === 'string') {
        return { parts: [entry], hasStructured: false };
    }
    const content = toRecord(entry);
    if (!content) {
        return null;
    }
    const text = typeof content.text === 'string' ? content.text : null;
    const structured = hasStructuredContent(content);
    const parts: MessagePart[] = [];
    if (text !== null) {
        parts.push(text);
    }
    if (structured) {
        parts.push(content);
    }
    return {
        parts,
        hasStructured: structured,
    };
};

const parseContent = (value: unknown): MessageContent | null => {
    if (!Array.isArray(value)) {
        return null;
    }
    const parts: MessagePart[] = [];
    let hasStructured = false;

    for (const entry of value) {
        const parsed = parseContentEntry(entry);
        if (!parsed) {
            return null;
        }
        parts.push(...parsed.parts);
        hasStructured = hasStructured || parsed.hasStructured;
    }

    return {
        content_type: hasStructured ? 'multimodal_text' : 'text',
        parts,
    };
};

const buildMessage = (
    rawMessage: JsonRecord,
    interaction: JsonRecord,
    interactionIndex: number,
    messageIndex: number,
    timestamp: number | null,
): Message | null => {
    const role = resolveRole(rawMessage.role);
    const content = parseContent(rawMessage.content);
    if (!role || !content) {
        return null;
    }
    const status = classifyStatus(rawMessage.status, interaction);
    const interactionId = nonEmptyString(interaction.interactionId) ?? `interaction-${interactionIndex}`;
    const id = `nova-${interactionIndex}-${messageIndex}-${interactionId}`;

    return {
        id,
        author: {
            role,
            name: role === 'assistant' ? 'Amazon Nova' : role === 'user' ? 'User' : null,
            metadata: {},
        },
        create_time: timestamp,
        update_time: timestamp,
        content,
        status,
        end_turn: status !== 'in_progress',
        weight: 1,
        metadata: {
            nova: {
                interactionId,
                messageStatus: normalizeStatus(rawMessage.status),
                interactionStatus: normalizeStatus(interaction.status),
                deepResearchStatus: normalizeStatus(interaction.deepResearchStatus),
            },
        },
        recipient: 'all',
        channel: null,
    };
};

const resolveConversationTitle = (payload: JsonRecord, interactions: JsonRecord[]) => {
    for (const interaction of interactions) {
        const title = firstNonEmptyString(
            interaction.conversationTitle,
            interaction.conversationName,
            interaction.sessionTitle,
        );
        if (title) {
            return title;
        }
    }
    return (
        firstNonEmptyString(payload.conversationTitle, payload.conversationName, payload.sessionTitle) ??
        'Amazon Nova Conversation'
    );
};

const resolveModel = (interactions: JsonRecord[]) => {
    for (let index = interactions.length - 1; index >= 0; index -= 1) {
        const interaction = interactions[index];
        if (!interaction) {
            continue;
        }
        const model = firstNonEmptyString(
            interaction.modelId,
            interaction.modelLookupName,
            interaction.modelArn,
            toRecord(interaction.model)?.id,
            toRecord(interaction.model)?.name,
        );
        if (model) {
            return model;
        }
    }
    return 'amazon-nova';
};

const resolveInteractions = (payload: unknown): { payload: JsonRecord; interactions: JsonRecord[] } | null => {
    const record = toRecord(payload);
    if (!record || !Array.isArray(record.conversationInteractions) || record.conversationInteractions.length === 0) {
        return null;
    }
    const interactions = record.conversationInteractions.map(toRecord);
    if (interactions.some((interaction) => !interaction)) {
        return null;
    }
    return { payload: record, interactions: interactions as JsonRecord[] };
};

export const isNovaConversationPayload = (payload: unknown): boolean => {
    const resolved = resolveInteractions(payload);
    if (!resolved) {
        return false;
    }
    return resolved.interactions.every((interaction) => {
        const conversationId = nonEmptyString(interaction.conversationId);
        const interactionId = nonEmptyString(interaction.interactionId);
        return (
            !!conversationId &&
            NOVA_CONVERSATION_ID_PATTERN.test(conversationId) &&
            !!interactionId &&
            NOVA_CONVERSATION_ID_PATTERN.test(interactionId) &&
            Array.isArray(interaction.messages)
        );
    });
};

type NovaMappingState = {
    mapping: Record<string, MessageNode>;
    parentId: string;
    messageCount: number;
    timestamps: number[];
};

const appendInteractionMessages = (
    state: NovaMappingState,
    interaction: JsonRecord,
    interactionIndex: number,
): boolean => {
    const rawMessages = interaction.messages as unknown[];
    const timestamp = parseTimestamp(interaction.interactionStartTime ?? interaction.creationTime);
    if (timestamp !== null) {
        state.timestamps.push(timestamp);
    }
    for (let messageIndex = 0; messageIndex < rawMessages.length; messageIndex += 1) {
        const rawMessage = toRecord(rawMessages[messageIndex]);
        if (!rawMessage) {
            return false;
        }
        const message = buildMessage(rawMessage, interaction, interactionIndex, messageIndex, timestamp);
        if (!message) {
            return false;
        }
        const node: MessageNode = {
            id: message.id,
            message,
            parent: state.parentId,
            children: [],
        };
        state.mapping[state.parentId]!.children.push(node.id);
        state.mapping[node.id] = node;
        state.parentId = node.id;
        state.messageCount += 1;
    }
    return true;
};

const buildNovaMapping = (interactions: JsonRecord[], rootId: string): NovaMappingState | null => {
    const state: NovaMappingState = {
        mapping: {
            [rootId]: { id: rootId, message: null, parent: null, children: [] },
        },
        parentId: rootId,
        messageCount: 0,
        timestamps: [],
    };
    for (let interactionIndex = 0; interactionIndex < interactions.length; interactionIndex += 1) {
        if (!appendInteractionMessages(state, interactions[interactionIndex]!, interactionIndex)) {
            return null;
        }
    }
    return state.messageCount > 0 ? state : null;
};

export const parseNovaConversationPayload = (payload: unknown): ConversationData | null => {
    const resolved = resolveInteractions(payload);
    if (!resolved || !isNovaConversationPayload(payload)) {
        return null;
    }
    const { interactions } = resolved;
    const conversationIds = new Set(interactions.map((interaction) => nonEmptyString(interaction.conversationId)!));
    if (conversationIds.size !== 1) {
        return null;
    }
    const conversationId = conversationIds.values().next().value as string;
    const rootId = `nova-root-${conversationId}`;
    const state = buildNovaMapping(interactions, rootId);
    if (!state) {
        return null;
    }
    const createTime = state.timestamps.length > 0 ? Math.min(...state.timestamps) : 0;
    const updateTime = state.timestamps.length > 0 ? Math.max(...state.timestamps) : createTime;

    return {
        title: resolveConversationTitle(resolved.payload, interactions),
        create_time: createTime,
        update_time: updateTime,
        mapping: state.mapping,
        conversation_id: conversationId,
        current_node: state.parentId,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: resolveModel(interactions),
        safe_urls: [],
        blocked_urls: [],
        raw_payload: payload as RawConversationPayload,
    };
};
