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

const jsonValuesEqual = (left: unknown, right: unknown): boolean => {
    if (Object.is(left, right)) {
        return true;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return (
            Array.isArray(left) &&
            Array.isArray(right) &&
            left.length === right.length &&
            left.every((value, index) => jsonValuesEqual(value, right[index]))
        );
    }
    const leftRecord = toRecord(left);
    const rightRecord = toRecord(right);
    if (!leftRecord || !rightRecord) {
        return false;
    }
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return (
        leftKeys.length === rightKeys.length &&
        leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key]))
    );
};

const resolveMessages = (data: JsonRecord): JsonRecord[] | null => {
    const chat = toRecord(data.chat);
    const directValues = Array.isArray(chat?.messages) ? chat.messages : [];
    const direct = directValues.map(toRecord);
    if (direct.some((message) => message === null)) {
        return null;
    }
    const history = toRecord(chat?.history);
    const keyedMessages = toRecord(history?.messages);
    const keyed = keyedMessages
        ? Object.entries(keyedMessages).map(([id, value]) => [id, toRecord(value)] as const)
        : [];
    if (keyed.some(([id, message]) => !message || message.id !== id)) {
        return null;
    }

    const parsedDirect = direct as JsonRecord[];
    const parsedKeyed = keyed.map(([, message]) => message!);
    if (parsedDirect.length > 0 && parsedKeyed.length > 0) {
        const keyedById = new Map(parsedKeyed.map((message) => [stringValue(message.id), message]));
        if (
            keyedById.size !== parsedKeyed.length ||
            parsedDirect.length !== parsedKeyed.length ||
            !parsedDirect.every((message) => {
                const id = stringValue(message.id);
                return id !== null && jsonValuesEqual(message, keyedById.get(id));
            })
        ) {
            return null;
        }
    }
    return parsedDirect.length > 0 ? parsedDirect : parsedKeyed;
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

const hasConsistentQwenLinks = (mapping: Record<string, MessageNode>, nodes: MessageNode[]): boolean => {
    for (const node of nodes) {
        if (node.parent !== null && !mapping[node.parent]) {
            return false;
        }
        const uniqueChildren = new Set(node.children);
        if (uniqueChildren.size !== node.children.length || node.children.some((childId) => !mapping[childId])) {
            return false;
        }
        const expectedChildren = nodes
            .filter((candidate) => candidate.parent === node.id)
            .map((candidate) => candidate.id);
        if (
            expectedChildren.length !== uniqueChildren.size ||
            expectedChildren.some((childId) => !uniqueChildren.has(childId))
        ) {
            return false;
        }
    }
    return true;
};

const hasConnectedQwenTree = (
    mapping: Record<string, MessageNode>,
    nodes: MessageNode[],
    rootId: string,
    currentNode: string,
): boolean => {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (nodeId: string): boolean => {
        if (visiting.has(nodeId)) {
            return false;
        }
        if (visited.has(nodeId)) {
            return true;
        }
        visiting.add(nodeId);
        for (const childId of mapping[nodeId]!.children) {
            if (!visit(childId)) {
                return false;
            }
        }
        visiting.delete(nodeId);
        visited.add(nodeId);
        return true;
    };
    return visit(rootId) && visited.size === nodes.length && visited.has(currentNode);
};

const createMapping = (messages: JsonRecord[], currentNode: string): Record<string, MessageNode> | null => {
    const mapping: Record<string, MessageNode> = {};
    for (const source of messages) {
        const node = createMessageNode(source);
        if (!node || mapping[node.id]) {
            return null;
        }
        mapping[node.id] = node;
    }
    const nodes = Object.values(mapping);
    const roots = nodes.filter((node) => node.parent === null);
    if (roots.length !== 1 || !mapping[currentNode] || mapping[currentNode]!.children.length > 0) {
        return null;
    }
    if (!hasConsistentQwenLinks(mapping, nodes) || !hasConnectedQwenTree(mapping, nodes, roots[0]!.id, currentNode)) {
        return null;
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
    const chat = toRecord(data.chat);
    const history = toRecord(chat?.history);
    const directCurrentNode = stringValue(data.currentId);
    const historyCurrentNode = stringValue(history?.currentId);
    if (directCurrentNode && historyCurrentNode && directCurrentNode !== historyCurrentNode) {
        return null;
    }
    const currentNode = directCurrentNode ?? historyCurrentNode;
    if (!messages || !currentNode) {
        return null;
    }
    const mapping = createMapping(messages, currentNode);
    if (!mapping?.[currentNode]?.message) {
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
