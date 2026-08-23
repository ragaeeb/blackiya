import type { Author, ConversationData, Message, MessageNode, RawConversationPayload } from '@/utils/types';
import { QWEN_CONVERSATION_ID_PATTERN } from './constants';
import { extractQwenConversationIdFromDetailUrl } from './requests';

type JsonRecord = Record<string, unknown>;

export type QwenConversationSummary = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
};

const toRecord = (value: unknown): JsonRecord | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;

const parsePayload = (data: unknown): JsonRecord | null => {
    if (typeof data !== 'string') {
        return toRecord(data);
    }
    try {
        return toRecord(JSON.parse(data));
    } catch {
        return null;
    }
};

const stringValue = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

const finiteNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

const stringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [];

const qwenRole = (value: unknown): Author['role'] | null => {
    if (value === 'system' || value === 'user' || value === 'assistant' || value === 'tool') {
        return value;
    }
    return null;
};

const resolveMessages = (data: JsonRecord): JsonRecord[] => {
    const chat = toRecord(data.chat);
    const direct = Array.isArray(chat?.messages)
        ? chat.messages.map(toRecord).filter((item): item is JsonRecord => !!item)
        : [];
    if (direct.length > 0) {
        return direct;
    }
    const history = toRecord(chat?.history);
    const keyedMessages = toRecord(history?.messages);
    return keyedMessages
        ? Object.values(keyedMessages)
              .map(toRecord)
              .filter((item): item is JsonRecord => !!item)
        : [];
};

const answerSegments = (message: JsonRecord): JsonRecord[] =>
    Array.isArray(message.content_list)
        ? message.content_list
              .map(toRecord)
              .filter((item): item is JsonRecord => !!item && item.phase === 'answer' && item.role === 'assistant')
        : [];

const answerTextParts = (message: JsonRecord): string[] => {
    const answers = answerSegments(message)
        .map((item) => stringValue(item.content))
        .filter((item): item is string => !!item);
    if (answers.length > 0) {
        return answers;
    }
    const fallback = stringValue(message.content);
    return fallback ? [fallback] : [];
};

const assistantIsFinished = (message: JsonRecord): boolean => {
    const answers = answerSegments(message);
    return (
        message.done === true &&
        message.is_stop === false &&
        message.error === null &&
        answers.length > 0 &&
        answers.every((answer) => answer.status === 'finished') &&
        answerTextParts(message).length > 0
    );
};

const normalizeMessage = (source: JsonRecord): Message | null => {
    const id = stringValue(source.id);
    const role = qwenRole(source.role);
    if (!id || !role) {
        return null;
    }
    const hasError = source.error !== null && source.error !== undefined;
    const finished = role === 'assistant' ? assistantIsFinished(source) : !hasError;
    const status: Message['status'] = hasError ? 'error' : finished ? 'finished_successfully' : 'in_progress';
    const model = stringValue(source.model) ?? stringArray(source.models)[0] ?? null;
    const statuses = answerSegments(source)
        .map((item) => stringValue(item.status))
        .filter((item): item is string => !!item);
    return {
        id,
        author: { role, name: role === 'assistant' ? 'Qwen' : null, metadata: {} },
        create_time: finiteNumber(source.timestamp),
        update_time: null,
        content: { content_type: 'text', parts: answerTextParts(source) },
        status,
        end_turn: role === 'assistant' ? finished : false,
        weight: 1,
        metadata: {
            qwen_done: source.done === true,
            qwen_is_stop: source.is_stop === true,
            qwen_answer_statuses: statuses,
            qwen_model: model,
        },
        recipient: 'all',
        channel: null,
    };
};

const createMessageNode = (source: JsonRecord): MessageNode | null => {
    const message = normalizeMessage(source);
    if (!message) {
        return null;
    }
    const parent = source.parentId === null ? null : stringValue(source.parentId);
    if (parent === message.id) {
        return null;
    }
    return {
        id: message.id,
        message,
        parent,
        children: stringArray(source.childrenIds).filter((childId) => childId !== message.id),
    };
};

const connectMessageNode = (mapping: Record<string, MessageNode>, node: MessageNode) => {
    if (node.parent && !mapping[node.parent]) {
        mapping[node.parent] = { id: node.parent, message: null, parent: null, children: [node.id] };
    } else if (node.parent && !mapping[node.parent]!.children.includes(node.id)) {
        mapping[node.parent]!.children.push(node.id);
    }
    for (const childId of node.children) {
        if (!mapping[childId]) {
            mapping[childId] = { id: childId, message: null, parent: node.id, children: [] };
        }
    }
};

const createMapping = (messages: JsonRecord[]): Record<string, MessageNode> | null => {
    const mapping: Record<string, MessageNode> = {};
    for (const source of messages) {
        const node = createMessageNode(source);
        if (!node || mapping[node.id]) {
            return null;
        }
        mapping[node.id] = node;
    }
    for (const node of Object.values(mapping)) {
        connectMessageNode(mapping, node);
    }
    return mapping;
};

const resolveDefaultModel = (data: JsonRecord, messages: JsonRecord[]): string => {
    const chat = toRecord(data.chat);
    const chatModel = stringArray(chat?.models)[0];
    if (chatModel) {
        return chatModel;
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const model = stringValue(messages[index]?.model);
        if (model) {
            return model;
        }
    }
    return 'qwen';
};

export const parseQwenConversationDetail = (raw: unknown, url: string): ConversationData | null => {
    const requestedConversationId = extractQwenConversationIdFromDetailUrl(url);
    const envelope = parsePayload(raw);
    if (!requestedConversationId || envelope?.success !== true) {
        return null;
    }
    const data = toRecord(envelope.data);
    const conversationId = stringValue(data?.id);
    if (!data || !conversationId || conversationId !== requestedConversationId) {
        return null;
    }
    const messages = resolveMessages(data);
    const mapping = createMapping(messages);
    const chat = toRecord(data.chat);
    const history = toRecord(chat?.history);
    const currentNode = stringValue(data.currentId) ?? stringValue(history?.currentId);
    if (!mapping || !currentNode || !mapping[currentNode]?.message) {
        return null;
    }
    return {
        title: stringValue(data.title) ?? 'Qwen Conversation',
        create_time: finiteNumber(data.created_at) ?? 0,
        update_time: finiteNumber(data.updated_at) ?? finiteNumber(data.created_at) ?? 0,
        mapping,
        conversation_id: conversationId,
        current_node: currentNode,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: data.archived === true,
        default_model_slug: resolveDefaultModel(data, messages),
        safe_urls: [],
        blocked_urls: [],
        raw_payload: envelope as RawConversationPayload,
    };
};

export const parseQwenConversationList = (raw: unknown): QwenConversationSummary[] | null => {
    const envelope = parsePayload(raw);
    if (envelope?.success !== true || !Array.isArray(envelope.data)) {
        return null;
    }
    const summaries: QwenConversationSummary[] = [];
    for (const value of envelope.data) {
        const item = toRecord(value);
        const id = stringValue(item?.id);
        const title = stringValue(item?.title);
        const createdAt = finiteNumber(item?.created_at);
        const updatedAt = finiteNumber(item?.updated_at);
        if (
            !item ||
            !id ||
            !QWEN_CONVERSATION_ID_PATTERN.test(id) ||
            !title ||
            createdAt === null ||
            updatedAt === null
        ) {
            return null;
        }
        summaries.push({ id, title, createdAt, updatedAt });
    }
    return summaries;
};
