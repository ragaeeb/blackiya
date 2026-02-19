import { logger } from '@/utils/logger';
import type { Author, ConversationData, Message, MessageContent, MessageNode } from '@/utils/types';
import { DEFAULT_GROK_MODEL_SLUG } from './constants';
import { grokState } from './state';
import {
    extractGrokComConversationIdFromUrl,
    isGrokComLoadResponsesEndpoint,
    isGrokComMetaEndpoint,
    isGrokComResponseNodesEndpoint,
} from './url-utils';

export const tryParseJsonIfNeeded = (data: unknown): unknown => {
    if (typeof data !== 'string') {
        return data;
    }
    try {
        return JSON.parse(data);
    } catch {
        return null;
    }
};

export const createGrokComConversation = (conversationId: string): ConversationData => {
    const rootId = `grok-com-root-${conversationId}`;
    const nowSeconds = Date.now() / 1000;
    const title = grokState.conversationTitles.get(conversationId) || 'Grok Conversation';

    const conversation: ConversationData = {
        title,
        create_time: nowSeconds,
        update_time: nowSeconds,
        mapping: {
            [rootId]: { id: rootId, message: null, parent: null, children: [] },
        },
        conversation_id: conversationId,
        current_node: rootId,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: DEFAULT_GROK_MODEL_SLUG,
        safe_urls: [],
        blocked_urls: [],
    };

    grokState.activeConversations.set(conversationId, conversation);
    return conversation;
};

export const getOrCreateGrokComConversation = (conversationId: string): ConversationData => {
    grokState.lastActiveConversationId = conversationId;
    return grokState.activeConversations.get(conversationId) ?? createGrokComConversation(conversationId);
};

export const ensureGrokComRoot = (conversation: ConversationData): string => {
    const existingRoot = Object.values(conversation.mapping).find((node) => node.parent === null);
    if (existingRoot) {
        return existingRoot.id;
    }

    const rootId = `grok-com-root-${conversation.conversation_id}`;
    conversation.mapping[rootId] = { id: rootId, message: null, parent: null, children: [] };
    conversation.current_node = rootId;
    return rootId;
};

export const ensureGrokComNode = (conversation: ConversationData, nodeId: string, rootId: string): MessageNode => {
    if (!conversation.mapping[nodeId]) {
        conversation.mapping[nodeId] = { id: nodeId, message: null, parent: rootId, children: [] };
    }
    return conversation.mapping[nodeId];
};

export const attachGrokComNodeToParent = (
    conversation: ConversationData,
    nodeId: string,
    parentId: string,
    rootId: string,
): void => {
    const parentKey = parentId || rootId;
    const node = ensureGrokComNode(conversation, nodeId, rootId);

    if (node.parent && conversation.mapping[node.parent]) {
        conversation.mapping[node.parent].children = conversation.mapping[node.parent].children.filter(
            (child) => child !== nodeId,
        );
    }

    node.parent = parentKey;
    const parentNode = ensureGrokComNode(conversation, parentKey, rootId);
    if (!parentNode.children.includes(nodeId)) {
        parentNode.children.push(nodeId);
    }
};

export const hasGrokComMessages = (conversation: ConversationData): boolean =>
    Object.values(conversation.mapping).some((node) => node.message !== null);

// ── Message building ───────────────────────────────────────────────────────────

const createGrokComAuthor = (sender: string): Author => ({
    role: sender === 'human' ? 'user' : 'assistant',
    name: sender === 'human' ? 'User' : 'Grok',
    metadata: {},
});

export const buildGrokComMessage = (
    responseId: string,
    sender: string,
    createdAt: number | null,
    isPartial: boolean,
    messageText: string,
    response: any,
): Message => ({
    id: responseId,
    author: createGrokComAuthor(sender),
    create_time: createdAt && !Number.isNaN(createdAt) ? createdAt : null,
    update_time: null,
    content: { content_type: 'text', parts: [messageText] } as MessageContent,
    status: isPartial ? 'in_progress' : 'finished_successfully',
    end_turn: !isPartial,
    weight: 1,
    metadata: {
        ...response?.metadata,
        model: response?.model ?? null,
        requestMetadata: response?.requestMetadata ?? null,
        sender,
        partial: isPartial,
    },
    recipient: 'all',
    channel: null,
});

// ── Response normalization ─────────────────────────────────────────────────────

const normalizeFromGrokComObject = (data: any): any[] | null => {
    if (typeof data.responseId === 'string') {
        return [data];
    }
    if (data.response && typeof data.response === 'object') {
        return [data.response];
    }

    const resultResponse = data.result?.response;
    if (!resultResponse || typeof resultResponse !== 'object') {
        return null;
    }

    const modelResp = resultResponse.modelResponse;
    const userResp = resultResponse.userResponse;
    if (modelResp && typeof modelResp.responseId === 'string') {
        return [modelResp];
    }
    if (userResp && typeof userResp.responseId === 'string') {
        return [userResp];
    }
    return null;
};

const normalizeFromGrokComArray = (data: any[]): any[] | null => {
    const direct = data.filter((item) => item && typeof item?.responseId === 'string');
    return direct.length > 0 ? direct : null;
};

export const normalizeGrokComResponses = (data: any): any[] | null => {
    if (Array.isArray(data?.responses)) {
        return data.responses;
    }
    if (data && typeof data === 'object') {
        const fromObj = normalizeFromGrokComObject(data);
        if (fromObj) {
            return fromObj;
        }
    }
    if (Array.isArray(data)) {
        const fromArr = normalizeFromGrokComArray(data);
        if (fromArr) {
            return fromArr;
        }
    }
    return null;
};

// ── Individual response item parsing ──────────────────────────────────────────

export const parseGrokComResponseItem = (response: any, rootId: string) => {
    const responseId = typeof response?.responseId === 'string' ? response.responseId : null;
    if (!responseId) {
        return null;
    }

    const createdAt = typeof response?.createTime === 'string' ? Date.parse(response.createTime) / 1000 : null;
    const messageText = typeof response?.message === 'string' ? response.message : '';
    const sender = typeof response?.sender === 'string' ? response.sender : 'assistant';
    const isPartial = Boolean(response?.partial);
    const parentResponseId = typeof response?.parentResponseId === 'string' ? response.parentResponseId : rootId;
    const model = typeof response?.model === 'string' ? response.model : null;

    return {
        responseId,
        parentResponseId,
        createdAt,
        model,
        messageObj: buildGrokComMessage(responseId, sender, createdAt, isPartial, messageText, response),
    };
};

// ── Endpoint parsers ───────────────────────────────────────────────────────────

export const parseGrokComResponses = (data: any, conversationId: string): ConversationData | null => {
    const responses = normalizeGrokComResponses(data);
    if (!responses) {
        return null;
    }

    const conversation = getOrCreateGrokComConversation(conversationId);
    const rootId = ensureGrokComRoot(conversation);
    let latestNodeId = conversation.current_node;
    let latestTimestamp = 0;

    for (const response of responses) {
        const parsed = parseGrokComResponseItem(response, rootId);
        if (!parsed) {
            continue;
        }

        const { responseId, parentResponseId, createdAt, model, messageObj } = parsed;
        const node = ensureGrokComNode(conversation, responseId, rootId);
        attachGrokComNodeToParent(conversation, responseId, parentResponseId, rootId);
        node.message = messageObj;

        if (createdAt && !Number.isNaN(createdAt)) {
            conversation.update_time = Math.max(conversation.update_time, createdAt);
            if (createdAt > latestTimestamp) {
                latestTimestamp = createdAt;
                latestNodeId = responseId;
            }
        }

        if (model && model.trim().length > 0) {
            conversation.default_model_slug = model;
        }
    }

    conversation.update_time = Math.max(conversation.update_time, latestTimestamp);
    conversation.current_node = latestNodeId;
    return conversation;
};

export const parseGrokComConversationMeta = (data: any, conversationId: string): ConversationData | null => {
    const conversation = data?.conversation;
    if (!conversation) {
        return null;
    }

    const title = typeof conversation.title === 'string' ? conversation.title : undefined;
    const createTime = typeof conversation.createTime === 'string' ? Date.parse(conversation.createTime) / 1000 : null;
    const updateTime = typeof conversation.modifyTime === 'string' ? Date.parse(conversation.modifyTime) / 1000 : null;

    if (title) {
        grokState.conversationTitles.set(conversationId, title);
    }

    const conversationData = getOrCreateGrokComConversation(conversationId);
    if (title) {
        conversationData.title = title;
    }
    if (createTime && !Number.isNaN(createTime)) {
        conversationData.create_time = createTime;
    }
    if (updateTime && !Number.isNaN(updateTime)) {
        conversationData.update_time = updateTime;
    }

    return hasGrokComMessages(conversationData) ? conversationData : null;
};

export const parseGrokComResponseNodes = (data: any, conversationId: string): ConversationData | null => {
    const nodes = Array.isArray(data?.responseNodes) ? data.responseNodes : null;
    if (!nodes) {
        return null;
    }

    const conversation = getOrCreateGrokComConversation(conversationId);
    const rootId = ensureGrokComRoot(conversation);

    for (const node of nodes) {
        const responseId = node?.responseId;
        if (typeof responseId !== 'string') {
            continue;
        }
        const parentId = typeof node?.parentResponseId === 'string' ? node.parentResponseId : rootId;
        attachGrokComNodeToParent(conversation, responseId, parentId, rootId);
    }

    return hasGrokComMessages(conversation) ? conversation : null;
};

export const parseGrokComLoadResponsesPayload = (data: unknown, conversationId: string): ConversationData | null => {
    let dataStr = '';
    if (typeof data === 'string') {
        dataStr = data;
    } else {
        const serialized = JSON.stringify(data);
        if (typeof serialized !== 'string') {
            return null;
        }
        dataStr = serialized;
    }
    const lines = dataStr
        .trim()
        .split('\n')
        .filter((line) => line.trim());

    if (lines.length <= 1) {
        const parsed = tryParseJsonIfNeeded(data);
        if (!parsed) {
            return null;
        }
        return parseGrokComResponses(parsed, conversationId);
    }

    logger.info(`[Blackiya/Grok] Parsing NDJSON with ${lines.length} lines`);
    let result: ConversationData | null = null;
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            const lineResult = parseGrokComResponses(parsed, conversationId);
            if (lineResult) {
                result = lineResult;
            }
        } catch {
            logger.warn(`[Blackiya/Grok] Failed to parse NDJSON line: ${line.slice(0, 100)}`);
        }
    }
    return result;
};

const resolveGrokComEndpointContext = (
    data: unknown,
    url: string,
    options: { parsePayload: boolean },
): { conversationId: string; parsed: unknown } | null => {
    const conversationId = extractGrokComConversationIdFromUrl(url);
    if (!conversationId) {
        return null;
    }
    if (!options.parsePayload) {
        return { conversationId, parsed: data };
    }
    const parsed = tryParseJsonIfNeeded(data);
    if (!parsed) {
        return null;
    }
    return { conversationId, parsed };
};

/**
 * Dispatch to the correct grok.com REST endpoint parser.
 * Returns `undefined` when the URL does not match any known grok.com REST path,
 * signalling the caller to try the next parsing strategy.
 */
export const tryParseGrokComRestEndpoint = (data: unknown, url: string): ConversationData | null | undefined => {
    if (isGrokComMetaEndpoint(url)) {
        const context = resolveGrokComEndpointContext(data, url, { parsePayload: true });
        return context ? parseGrokComConversationMeta(context.parsed, context.conversationId) : null;
    }

    if (isGrokComResponseNodesEndpoint(url)) {
        const context = resolveGrokComEndpointContext(data, url, { parsePayload: true });
        return context ? parseGrokComResponseNodes(context.parsed, context.conversationId) : null;
    }

    if (isGrokComLoadResponsesEndpoint(url)) {
        const context = resolveGrokComEndpointContext(data, url, { parsePayload: false });
        return context ? parseGrokComLoadResponsesPayload(context.parsed, context.conversationId) : null;
    }

    return undefined;
};
