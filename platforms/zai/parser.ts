import type {
    Author,
    ConversationData,
    Message,
    MessageContent,
    MessageNode,
    RawConversationPayload,
} from '@/utils/types';
import { isZaiConversationId } from './constants';

type JsonRecord = Record<string, unknown>;

const DEFAULT_TITLE = 'Z.ai Conversation';
const DEFAULT_MODEL = 'zai';

const toRecord = (value: unknown): JsonRecord | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;

const parseRecord = (value: unknown): JsonRecord | null => {
    if (typeof value !== 'string') {
        return toRecord(value);
    }
    try {
        return toRecord(JSON.parse(value));
    } catch {
        return null;
    }
};

const toRawPayload = (value: JsonRecord): RawConversationPayload => value as RawConversationPayload;

const readFiniteNumber = (...values: unknown[]): number | null => {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value > 100_000_000_000 ? value / 1000 : value;
        }
    }
    return null;
};

const readString = (...values: unknown[]): string | null => {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    return null;
};

const readStringArray = (value: unknown): string[] | null =>
    Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;

const readRole = (value: unknown): Author['role'] | null => {
    if (value === 'assistant' || value === 'user' || value === 'system' || value === 'tool') {
        return value;
    }
    return null;
};

const authorName = (role: Author['role']): string | null => {
    if (role === 'assistant') {
        return 'Z.ai';
    }
    if (role === 'user') {
        return 'User';
    }
    return null;
};

const extractTextParts = (message: JsonRecord): string[] => {
    const blocks = message.content_blocks;
    if (Array.isArray(blocks)) {
        const textBlocks = blocks.flatMap((block) => {
            const record = toRecord(block);
            return record?.type === 'text' && typeof record.content === 'string' ? [record.content] : [];
        });
        if (textBlocks.length > 0) {
            return textBlocks;
        }
    }
    return typeof message.content === 'string' ? [message.content] : [];
};

const createMessage = (source: 'detail' | 'messages_batch', message: JsonRecord, role: Author['role']): Message => {
    const id = message.id as string;
    const done = source === 'messages_batch' && message.done === true;
    const hasError = source === 'messages_batch' && message.error !== null && message.error !== undefined;
    const isAssistant = role === 'assistant';
    const parts = extractTextParts(message);
    const status: Message['status'] = hasError
        ? 'error'
        : isAssistant && !done
          ? 'in_progress'
          : 'finished_successfully';
    const content: MessageContent = { content_type: 'text', parts };

    return {
        id,
        author: { role, name: authorName(role), metadata: {} },
        create_time: readFiniteNumber(message.created_at, message.timestamp),
        update_time: readFiniteNumber(message.updated_at),
        content,
        status,
        end_turn: isAssistant ? done : false,
        weight: 1,
        metadata: {
            zai_done: done,
            zai_source: source,
            ...(hasError ? { zai_error: true } : {}),
        },
        recipient: 'all',
        channel: null,
    };
};

type ParsedMapping = {
    mapping: Record<string, MessageNode>;
    model: string;
};

type ParsedMappingNode = {
    node: MessageNode;
    model: string | null;
};

const parseMappingNode = (
    messageId: string,
    rawMessage: unknown,
    source: 'detail' | 'messages_batch',
): ParsedMappingNode | null => {
    const message = toRecord(rawMessage);
    if (!message || !isZaiConversationId(messageId) || message.id !== messageId) {
        return null;
    }

    const role = readRole(message.role);
    const childrenIds = readStringArray(message.childrenIds);
    if (!role || !childrenIds || childrenIds.some((id) => !isZaiConversationId(id))) {
        return null;
    }

    const parentIdCamel = message.parentId;
    const parentIdSnake = message.parent_id;
    if (typeof parentIdCamel === 'string' && typeof parentIdSnake === 'string' && parentIdCamel !== parentIdSnake) {
        return null;
    }

    const parentId = readString(parentIdCamel, parentIdSnake);
    const explicitNullParent = parentIdCamel === null || parentIdSnake === null;
    if (!parentId && !explicitNullParent) {
        return null;
    }

    return {
        node: {
            id: messageId,
            message: createMessage(source, message, role),
            parent: parentId,
            children: [...childrenIds],
        },
        model: readString(message.model_name, message.model),
    };
};

const hasConsistentEdges = (mapping: Record<string, MessageNode>, nodes: MessageNode[]): boolean => {
    for (const node of nodes) {
        if (new Set(node.children).size !== node.children.length) {
            return false;
        }
        if (node.parent && !mapping[node.parent]) {
            return false;
        }
        if (node.children.some((childId) => !mapping[childId])) {
            return false;
        }
        if (node.parent && !mapping[node.parent]?.children.includes(node.id)) {
            return false;
        }
        if (node.children.some((childId) => mapping[childId]?.parent !== node.id)) {
            return false;
        }
    }
    return true;
};

const hasCompleteDepthFirstCoverage = (
    mapping: Record<string, MessageNode>,
    rootId: string,
    nodeCount: number,
): boolean => {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (nodeId: string): boolean => {
        if (visiting.has(nodeId) || visited.has(nodeId)) {
            return false;
        }
        visiting.add(nodeId);
        for (const childId of mapping[nodeId]?.children ?? []) {
            if (!visit(childId)) {
                return false;
            }
        }
        visiting.delete(nodeId);
        visited.add(nodeId);
        return true;
    };

    return visit(rootId) && visited.size === nodeCount;
};

const isCanonicalMapping = (mapping: Record<string, MessageNode>): boolean => {
    const nodes = Object.values(mapping);
    const roots = nodes.filter((node) => node.parent === null);
    const root = roots[0];
    return Boolean(
        roots.length === 1 &&
            root &&
            hasConsistentEdges(mapping, nodes) &&
            hasCompleteDepthFirstCoverage(mapping, root.id, nodes.length),
    );
};

const parseMapping = (messages: JsonRecord, source: 'detail' | 'messages_batch'): ParsedMapping | null => {
    const mapping: Record<string, MessageNode> = {};
    let model = DEFAULT_MODEL;

    for (const [messageId, rawMessage] of Object.entries(messages)) {
        const parsed = parseMappingNode(messageId, rawMessage, source);
        if (!parsed) {
            return null;
        }
        mapping[messageId] = parsed.node;
        model = parsed.model ?? model;
    }

    if (Object.keys(mapping).length === 0 || !isCanonicalMapping(mapping)) {
        return null;
    }
    return { mapping, model };
};

const resolveCurrentNode = (mapping: Record<string, MessageNode>, preferred?: unknown): string | null => {
    if (typeof preferred === 'string' && mapping[preferred]) {
        return preferred;
    }

    const leaves = Object.values(mapping).filter((node) => node.children.length === 0);
    const candidates = leaves.length > 0 ? leaves : Object.values(mapping);
    const latest = candidates.sort((left, right) => {
        const leftTime = left.message?.update_time ?? left.message?.create_time ?? 0;
        const rightTime = right.message?.update_time ?? right.message?.create_time ?? 0;
        return rightTime - leftTime;
    })[0];
    return latest?.id ?? null;
};

const isReachableLeaf = (mapping: Record<string, MessageNode>, nodeId: string): boolean => {
    const current = mapping[nodeId];
    if (current?.children.length !== 0) {
        return false;
    }

    const visited = new Set<string>();
    let cursor: string | null = nodeId;
    while (cursor) {
        if (visited.has(cursor)) {
            return false;
        }
        visited.add(cursor);
        const node: MessageNode | undefined = mapping[cursor];
        if (!node) {
            return false;
        }
        cursor = node.parent;
    }
    return visited.size > 0;
};

const mappingTimes = (mapping: Record<string, MessageNode>) => {
    const createTimes = Object.values(mapping).flatMap((node) =>
        typeof node.message?.create_time === 'number' ? [node.message.create_time] : [],
    );
    const updateTimes = Object.values(mapping).flatMap((node) => {
        const time = node.message?.update_time ?? node.message?.create_time;
        return typeof time === 'number' ? [time] : [];
    });
    return {
        createTime: createTimes.length > 0 ? Math.min(...createTimes) : 0,
        updateTime: updateTimes.length > 0 ? Math.max(...updateTimes) : 0,
    };
};

const createConversationData = (input: {
    title: string;
    conversationId: string;
    currentNode: string;
    mapping: Record<string, MessageNode>;
    createTime: number;
    updateTime: number;
    model: string;
    archived: boolean;
    rawPayload: RawConversationPayload;
}): ConversationData => ({
    title: input.title,
    create_time: input.createTime,
    update_time: input.updateTime,
    mapping: input.mapping,
    conversation_id: input.conversationId,
    current_node: input.currentNode,
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: input.archived,
    default_model_slug: input.model,
    safe_urls: [],
    blocked_urls: [],
    raw_payload: input.rawPayload,
});

export const parseZaiConversationDetail = (
    payload: unknown,
    expectedConversationId?: string,
): ConversationData | null => {
    const root = parseRecord(payload);
    const chat = toRecord(root?.chat);
    const history = toRecord(chat?.history);
    const messages = toRecord(history?.messages);
    const conversationId = root?.id;

    if (
        !root ||
        !chat ||
        !history ||
        !messages ||
        !isZaiConversationId(conversationId) ||
        chat.id !== conversationId ||
        (expectedConversationId !== undefined && conversationId !== expectedConversationId)
    ) {
        return null;
    }

    const parsedMapping = parseMapping(messages, 'detail');
    const currentId = history.currentId;
    const currentNode =
        parsedMapping && isZaiConversationId(currentId) && isReachableLeaf(parsedMapping.mapping, currentId)
            ? currentId
            : null;
    if (!parsedMapping || !currentNode) {
        return null;
    }

    const model = readString(Array.isArray(chat.models) ? chat.models[0] : null, parsedMapping.model) ?? DEFAULT_MODEL;
    const times = mappingTimes(parsedMapping.mapping);
    return createConversationData({
        title: readString(root.title) ?? DEFAULT_TITLE,
        conversationId,
        currentNode,
        mapping: parsedMapping.mapping,
        createTime: readFiniteNumber(root.created_at, times.createTime) ?? times.createTime,
        updateTime: readFiniteNumber(root.updated_at, times.updateTime) ?? times.updateTime,
        model,
        archived: root.archived === true,
        rawPayload: toRawPayload(root),
    });
};

export const parseZaiMessagesBatch = (payload: unknown, expectedConversationId?: string): ConversationData | null => {
    const root = parseRecord(payload);
    const messages = toRecord(root?.data);
    const conversationId = root?.chat_id;

    if (
        !root ||
        !messages ||
        !isZaiConversationId(conversationId) ||
        (expectedConversationId !== undefined && conversationId !== expectedConversationId)
    ) {
        return null;
    }

    for (const message of Object.values(messages)) {
        if (toRecord(message)?.chat_id !== conversationId) {
            return null;
        }
    }

    const parsedMapping = parseMapping(messages, 'messages_batch');
    const currentNode = parsedMapping ? resolveCurrentNode(parsedMapping.mapping) : null;
    if (!parsedMapping || !currentNode) {
        return null;
    }

    const times = mappingTimes(parsedMapping.mapping);
    return createConversationData({
        title: DEFAULT_TITLE,
        conversationId,
        currentNode,
        mapping: parsedMapping.mapping,
        createTime: times.createTime,
        updateTime: times.updateTime,
        model: parsedMapping.model,
        archived: false,
        rawPayload: toRawPayload(root),
    });
};

export const mergeZaiConversationPayloads = (
    detailPayload: unknown,
    messagesBatchPayload: unknown,
    expectedConversationId?: string,
): ConversationData | null => {
    const detail = parseZaiConversationDetail(detailPayload, expectedConversationId);
    const batch = parseZaiMessagesBatch(messagesBatchPayload, expectedConversationId);
    if (!detail || !batch || detail.conversation_id !== batch.conversation_id) {
        return null;
    }

    const detailIds = Object.keys(detail.mapping).sort();
    const batchIds = Object.keys(batch.mapping).sort();
    if (detailIds.length !== batchIds.length || detailIds.some((id, index) => id !== batchIds[index])) {
        return null;
    }
    if (!isReachableLeaf(batch.mapping, detail.current_node)) {
        return null;
    }

    return {
        ...detail,
        mapping: batch.mapping,
        current_node: detail.current_node,
        update_time: Math.max(detail.update_time, batch.update_time),
        default_model_slug: batch.default_model_slug || detail.default_model_slug,
        raw_payload: {
            detail: detail.raw_payload ?? null,
            messages_batch: batch.raw_payload ?? null,
        },
    };
};

export const isZaiConversationPayload = (payload: unknown): boolean => {
    const root = parseRecord(payload);
    return Boolean(root && (toRecord(root.chat)?.history || toRecord(root.data)));
};
