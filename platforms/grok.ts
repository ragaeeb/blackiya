/**
 * Grok Platform Adapter - With Title Support
 *
 * Enhancements:
 * 1. Intercepts GrokHistory API calls to capture conversation titles
 * 2. Caches title mappings (conversationId -> title)
 * 3. Uses cached titles when building ConversationData
 * 4. Retroactively updates active conversations when titles arrive
 */

import type { LLMPlatform } from '@/platforms/types';
import { generateTimestamp, sanitizeFilename } from '@/utils/download';
import { logger } from '@/utils/logger';
import { LRUCache } from '@/utils/lru-cache';
import type { Author, ConversationData, Message, MessageContent, MessageNode } from '@/utils/types';

const MAX_TITLE_LENGTH = 80;

/**
 * Regex pattern to match a valid Grok conversation ID
 * Format: numeric string (e.g., "2013295304527827227")
 */
const X_CONVERSATION_ID_PATTERN = /^\d{10,20}$/;
const GROK_COM_CONVERSATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * In-memory cache for conversation titles
 * Maps conversation ID (rest_id) to title
 */
const conversationTitles = new LRUCache<string, string>(50);

/**
 * Track active conversation objects to allow retroactive title updates
 * Maps conversation ID -> ConversationData object reference
 */
const activeConversations = new LRUCache<string, ConversationData>(50);

const createGrokComConversation = (conversationId: string) => {
    const rootId = `grok-com-root-${conversationId}`;
    const nowSeconds = Date.now() / 1000;
    const title = conversationTitles.get(conversationId) || 'Grok Conversation';

    const conversation: ConversationData = {
        title: title,
        create_time: nowSeconds,
        update_time: nowSeconds,
        mapping: {
            [rootId]: {
                id: rootId,
                message: null,
                parent: null,
                children: [],
            },
        },
        conversation_id: conversationId,
        current_node: rootId,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: 'grok-4',
        safe_urls: [],
        blocked_urls: [],
    };

    activeConversations.set(conversationId, conversation);
    return conversation;
};

const getOrCreateGrokComConversation = (conversationId: string) => {
    const existing = activeConversations.get(conversationId);
    if (existing) {
        return existing;
    }
    return createGrokComConversation(conversationId);
};

const ensureGrokComRoot = (conversation: ConversationData) => {
    const existingRoot = Object.values(conversation.mapping).find((node) => node.parent === null);
    if (existingRoot) {
        return existingRoot.id;
    }

    const rootId = `grok-com-root-${conversation.conversation_id}`;
    conversation.mapping[rootId] = {
        id: rootId,
        message: null,
        parent: null,
        children: [],
    };
    conversation.current_node = rootId;
    return rootId;
};

const ensureGrokComNode = (conversation: ConversationData, nodeId: string, rootId: string) => {
    if (!conversation.mapping[nodeId]) {
        conversation.mapping[nodeId] = {
            id: nodeId,
            message: null,
            parent: rootId,
            children: [],
        };
    }
    return conversation.mapping[nodeId];
};

const attachGrokComNodeToParent = (
    conversation: ConversationData,
    nodeId: string,
    parentId: string,
    rootId: string,
) => {
    const parentKey = parentId || rootId;
    const node = ensureGrokComNode(conversation, nodeId, rootId);

    if (node.parent && conversation.mapping[node.parent]) {
        const siblings = conversation.mapping[node.parent].children;
        conversation.mapping[node.parent].children = siblings.filter((child) => child !== nodeId);
    }

    node.parent = parentKey;
    const parentNode = ensureGrokComNode(conversation, parentKey, rootId);
    if (!parentNode.children.includes(nodeId)) {
        parentNode.children.push(nodeId);
    }
};

const hasGrokComMessages = (conversation: ConversationData) =>
    Object.values(conversation.mapping).some((node) => node.message !== null);

const parseGrokComConversationMeta = (data: any, conversationId: string) => {
    const conversation = data?.conversation;
    if (!conversation) {
        return null;
    }

    const title = typeof conversation.title === 'string' ? conversation.title : undefined;
    const createTime = typeof conversation.createTime === 'string' ? Date.parse(conversation.createTime) / 1000 : null;
    const updateTime = typeof conversation.modifyTime === 'string' ? Date.parse(conversation.modifyTime) / 1000 : null;

    if (title) {
        conversationTitles.set(conversationId, title);
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

const createGrokComAuthor = (sender: string) => {
    if (sender === 'human') {
        const author: Author = {
            role: 'user',
            name: 'User',
            metadata: {},
        };
        return author;
    }

    const author: Author = {
        role: 'assistant',
        name: 'Grok',
        metadata: {},
    };
    return author;
};

const parseGrokComResponseNodes = (data: any, conversationId: string) => {
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

const buildGrokComMessage = (
    responseId: string,
    sender: string,
    createdAt: number | null,
    isPartial: boolean,
    messageText: string,
    response: any,
) => {
    const content: MessageContent = {
        content_type: 'text',
        parts: [messageText],
    };

    const messageObj: Message = {
        id: responseId,
        author: createGrokComAuthor(sender),
        create_time: createdAt && !Number.isNaN(createdAt) ? createdAt : null,
        update_time: null,
        content: content,
        status: isPartial ? 'in_progress' : 'finished_successfully',
        end_turn: !isPartial,
        weight: 1,
        metadata: {
            ...response?.metadata,
            model: response?.model ?? null,
            requestMetadata: response?.requestMetadata ?? null,
            sender: sender,
            partial: isPartial,
        },
        recipient: 'all',
        channel: null,
    };

    return messageObj;
};

const parseGrokComResponseItem = (response: any, rootId: string) => {
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

const parseGrokComResponses = (data: any, conversationId: string) => {
    const responses = Array.isArray(data?.responses) ? data.responses : null;
    if (!responses) {
        return null;
    }

    const conversation = getOrCreateGrokComConversation(conversationId);
    const rootId = ensureGrokComRoot(conversation);
    let latestNodeId = conversation.current_node;
    let latestTimestamp = conversation.update_time;

    for (const response of responses) {
        const parsedResponse = parseGrokComResponseItem(response, rootId);
        if (!parsedResponse) {
            continue;
        }

        const { responseId, parentResponseId, createdAt, model, messageObj } = parsedResponse;
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

    conversation.current_node = latestNodeId;
    return conversation;
};

const isGrokComMetaEndpoint = (url: string) => url.includes('/rest/app-chat/conversations_v2/');

const isGrokComResponseNodesEndpoint = (url: string) =>
    url.includes('/rest/app-chat/conversations/') && url.includes('/response-node');

const isGrokComLoadResponsesEndpoint = (url: string) =>
    url.includes('/rest/app-chat/conversations/') && url.includes('/load-responses');

const extractGrokComConversationIdFromUrl = (url: string) => {
    try {
        const urlObj = new URL(url);
        const match = urlObj.pathname.match(
            /\/rest\/app-chat\/conversations_v2\/([^/]+)|\/rest\/app-chat\/conversations\/([^/]+)/,
        );
        const conversationId = match?.[1] ?? match?.[2] ?? null;
        if (!conversationId) {
            return null;
        }
        return GROK_COM_CONVERSATION_ID_PATTERN.test(conversationId) ? conversationId : null;
    } catch {
        return null;
    }
};

/**
 * Parse the GrokHistory response to extract conversation titles
 */
const parseTitlesResponse = (data: string, url: string) => {
    try {
        logger.info('[Blackiya/Grok/Titles] Attempting to parse titles from:', url);

        const parsed = JSON.parse(data);
        const historyData = parsed?.data?.grok_conversation_history;

        if (!historyData || !Array.isArray(historyData.items)) {
            logger.info('[Blackiya/Grok/Titles] No conversation history items found');
            return null;
        }

        const titles = new Map<string, string>();

        for (const item of historyData.items) {
            const restId = item?.grokConversation?.rest_id;
            const title = item?.title;

            if (typeof restId === 'string' && typeof title === 'string') {
                titles.set(restId, title);

                // Retroactively update any active conversation object
                if (activeConversations.has(restId)) {
                    const activeObj = activeConversations.get(restId);
                    if (activeObj && activeObj.title !== title) {
                        activeObj.title = title;
                        logger.info(
                            `[Blackiya/Grok/Titles] Retroactively updated title for active conversation: ${restId} -> "${title}"`,
                        );
                    }
                }
            }
        }

        logger.info(`[Blackiya/Grok/Titles] Extracted ${titles.size} conversation titles`);
        return titles;
    } catch (e) {
        logger.error('[Blackiya/Grok/Titles] Failed to parse titles:', e);
        return null;
    }
};

/**
 * Check if a URL is a GrokHistory (conversation list) endpoint
 */
const isTitlesEndpoint = (url: string) => {
    const isTitles = url.includes('GrokHistory');
    if (isTitles) {
        logger.info('[Blackiya/Grok/Titles] Detected titles endpoint');
    }
    return isTitles;
};

/**
 * Extract thinking/reasoning content from Grok message
 */

const extractThinkingContent = (chatItem: any) => {
    // Check if there are deepsearch_headers which contain reasoning steps
    if (Array.isArray(chatItem?.deepsearch_headers)) {
        const thoughts = chatItem.deepsearch_headers.flatMap((header: any) =>
            Array.isArray(header?.steps)
                ? header.steps
                      .filter((step: any) => step?.final_message)
                      .map((step: any) => ({
                          summary: header.header || 'Reasoning',
                          content: step.final_message,
                          chunks: [],
                          finished: true,
                      }))
                : [],
        );

        return thoughts.length > 0 ? thoughts : undefined;
    }

    return undefined;
};

/**
 * Determine sender type and create Author object
 */
const createAuthor = (senderType: string) => {
    if (senderType === 'User') {
        const author: Author = {
            role: 'user',
            name: 'User',
            metadata: {},
        };
        return author;
    }

    // Agent (Grok AI)
    const author: Author = {
        role: 'assistant',
        name: 'Grok',
        metadata: {},
    };
    return author;
};

const parseGrokItem = (item: any) => {
    const chatItemId = item?.chat_item_id;
    if (!chatItemId) {
        return null;
    }

    const createdAtMs = item?.created_at_ms;
    const grokMode = item?.grok_mode || 'Normal';
    const messageText = item?.message || '';
    const senderType = item?.sender_type || 'Agent';
    const isPartial = item?.is_partial || false;
    const thoughts = extractThinkingContent(item);

    const content: MessageContent = {
        content_type: thoughts ? 'thoughts' : 'text',
        parts: [messageText],
        thoughts: thoughts,
    };

    const messageObj: Message = {
        id: chatItemId,
        author: createAuthor(senderType),
        create_time: createdAtMs ? createdAtMs / 1000 : null,
        update_time: null,
        content: content,
        status: isPartial ? 'in_progress' : 'finished_successfully',
        end_turn: !isPartial,
        weight: 1,
        metadata: {
            grok_mode: grokMode,
            sender_type: senderType,
            is_partial: isPartial,
            thinking_trace: item?.thinking_trace || '',
            ui_layout: item?.ui_layout || {},
        },
        recipient: 'all',
        channel: null,
    };

    return {
        chatItemId,
        createdAtMs,
        senderType,
        messageText,
        messageObj,
    };
};

const getConversationId = (conversationIdOverride: string | undefined, chatItemId: string | undefined) =>
    conversationIdOverride || chatItemId || '';

const getTitleFromFirstItem = (conversationId: string, senderType: string, messageText: string) => {
    if (senderType !== 'User' || !messageText || conversationTitles.has(conversationId)) {
        return null;
    }

    const firstLine = messageText.split('\n')[0];
    if (!firstLine || firstLine.length >= 100) {
        return null;
    }

    return firstLine;
};

const createGrokRootNode = () => ({
    id: 'grok-root',
    message: null,
    parent: null,
    children: [],
});

const updateConversationFromItem = (
    state: {
        mapping: Record<string, MessageNode>;
        rootId: string;
        previousNodeId: string;
        conversationId: string;
        conversationTitle: string;
        createTime: number;
        updateTime: number;
    },
    parsedItem: {
        chatItemId: string;
        createdAtMs?: number;
        senderType: string;
        messageText: string;
        messageObj: Message;
    },
    index: number,
    conversationIdOverride?: string,
) => {
    if (index === 0) {
        state.conversationId = getConversationId(conversationIdOverride, parsedItem.chatItemId);
        const titleCandidate = getTitleFromFirstItem(
            state.conversationId,
            parsedItem.senderType,
            parsedItem.messageText,
        );
        if (titleCandidate) {
            state.conversationTitle = titleCandidate;
        }
    }

    if (parsedItem.createdAtMs) {
        const timestamp = parsedItem.createdAtMs / 1000;
        if (index === 0) {
            state.createTime = timestamp;
        }
        state.updateTime = Math.max(state.updateTime, timestamp);
    }

    state.mapping[parsedItem.chatItemId] = {
        id: parsedItem.chatItemId,
        message: parsedItem.messageObj,
        parent: state.previousNodeId,
        children: [],
    };

    const parentNode = state.mapping[state.previousNodeId];
    if (parentNode) {
        parentNode.children.push(parsedItem.chatItemId);
    }

    state.previousNodeId = parsedItem.chatItemId;
};

/**
 * Parse Grok API response into ConversationData
 */
const parseGrokResponse = (data: any, conversationIdOverride?: string) => {
    try {
        const conversationData = data?.data?.grok_conversation_items_by_rest_id;
        if (!conversationData) {
            logger.info('[Blackiya/Grok] No conversation data found in response');
            return null;
        }

        const items = conversationData.items;
        if (!Array.isArray(items) || items.length === 0) {
            logger.info('[Blackiya/Grok] No conversation items found');
            return null;
        }

        // Build the conversation mapping
        const mapping: Record<string, MessageNode> = {};
        let conversationId = '';
        let conversationTitle = 'Grok Conversation';
        let createTime = Date.now() / 1000;
        let updateTime = Date.now() / 1000;

        const rootNode = createGrokRootNode();
        const rootId = rootNode.id;
        mapping[rootId] = rootNode;

        const previousNodeId = rootId;

        const state = {
            mapping,
            rootId,
            previousNodeId,
            conversationId,
            conversationTitle,
            createTime,
            updateTime,
        };

        for (let i = 0; i < items.length; i++) {
            const parsedItem = parseGrokItem(items[i]);
            if (!parsedItem) {
                continue;
            }
            updateConversationFromItem(state, parsedItem, i, conversationIdOverride);
        }

        conversationId = state.conversationId;
        conversationTitle = state.conversationTitle;
        createTime = state.createTime;
        updateTime = state.updateTime;

        // Get the last node ID
        const lastNodeId = items.length > 0 ? items[items.length - 1].chat_item_id : rootId;

        // Check if we have a cached title for this conversation
        if (conversationId && conversationTitles.has(conversationId)) {
            conversationTitle = conversationTitles.get(conversationId)!;
            logger.info('[Blackiya/Grok] Using cached title:', conversationTitle);
        }

        const result: ConversationData = {
            title: conversationTitle,
            create_time: createTime,
            update_time: updateTime,
            mapping: mapping,
            conversation_id: conversationId,
            current_node: lastNodeId,
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'grok-2',
            safe_urls: [],
            blocked_urls: [],
        };

        // Store in active conversations map for potential retroactive title updates
        if (conversationId) {
            activeConversations.set(conversationId, result);
        }

        logger.info('[Blackiya/Grok] Successfully parsed conversation with', Object.keys(mapping).length, 'nodes');
        return result;
    } catch (e) {
        logger.error('[Blackiya/Grok] Failed to parse conversation:', e);
        if (e instanceof Error) {
            logger.error('[Blackiya/Grok] Error stack:', e.stack);
        }
        return null;
    }
};

/**
 * Grok Platform Adapter
 *
 * Supports grok.com and x.com Grok conversations
 */
export const grokAdapter: LLMPlatform = {
    name: 'Grok',

    urlMatchPattern: 'https://grok.com/*',

    // Match BOTH the conversation endpoint AND the history endpoint
    apiEndpointPattern:
        /\/i\/api\/graphql\/[^/]+\/(GrokConversationItemsByRestId|GrokHistory)|grok\.com\/rest\/app-chat\/conversations(_v2)?\/[^/]+(\/(response-node|load-responses))?/,

    /**
     * Check if a URL belongs to Grok
     */
    isPlatformUrl(url: string) {
        return url.includes('x.com/i/grok') || url.includes('grok.com/c/');
    },

    /**
     * Extract conversation ID from Grok URL
     *
     * Supports:
     * - https://x.com/i/grok?conversation={id}
     * - https://x.com/i/grok?conversation={id}&other=params
     *
     * @param url - The current page URL
     * @returns The conversation ID or null if not found/invalid
     */
    extractConversationId(url: string) {
        try {
            const urlObj = new URL(url);

            // Validate hostname
            if (urlObj.hostname === 'grok.com') {
                if (!urlObj.pathname.startsWith('/c/')) {
                    return null;
                }

                const match = urlObj.pathname.match(/\/c\/([a-f0-9-]+)/i);
                const conversationId = match?.[1] ?? null;
                if (!conversationId) {
                    return null;
                }

                return GROK_COM_CONVERSATION_ID_PATTERN.test(conversationId) ? conversationId : null;
            }

            if (urlObj.hostname !== 'x.com') {
                return null;
            }

            // Check if path is /i/grok
            if (!urlObj.pathname.startsWith('/i/grok')) {
                return null;
            }

            // Extract conversation ID from query parameter
            const conversationId = urlObj.searchParams.get('conversation');
            if (!conversationId) {
                return null;
            }

            // Validate format (numeric string)
            if (!X_CONVERSATION_ID_PATTERN.test(conversationId)) {
                return null;
            }

            return conversationId;
        } catch {
            return null;
        }
    },

    /**
     * Parse intercepted Grok API response
     *
     * @param data - Raw text or parsed object
     * @param url - The API endpoint URL
     */
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Centralized logic for parsing Grok data
    parseInterceptedData(data: string | any, url: string) {
        // Check if this is a titles endpoint
        if (isTitlesEndpoint(url)) {
            const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
            const titles = parseTitlesResponse(dataStr, url);
            if (titles) {
                // Merge into global cache
                for (const [id, title] of titles) {
                    conversationTitles.set(id, title);
                }
                logger.info(`[Blackiya/Grok] Title cache now contains ${conversationTitles.size} entries`);
            } else {
                logger.info('[Blackiya/Grok/Titles] Failed to extract titles from this response');
            }
            // Don't return ConversationData for title endpoints
            return null;
        }

        // grok.com conversation metadata
        if (isGrokComMetaEndpoint(url)) {
            const conversationId = extractGrokComConversationIdFromUrl(url);
            if (!conversationId) {
                return null;
            }
            const parsed = typeof data === 'string' ? JSON.parse(data) : data;
            return parseGrokComConversationMeta(parsed, conversationId);
        }

        // grok.com response-node graph
        if (isGrokComResponseNodesEndpoint(url)) {
            const conversationId = extractGrokComConversationIdFromUrl(url);
            if (!conversationId) {
                return null;
            }
            const parsed = typeof data === 'string' ? JSON.parse(data) : data;
            return parseGrokComResponseNodes(parsed, conversationId);
        }

        // grok.com responses payload
        if (isGrokComLoadResponsesEndpoint(url)) {
            const conversationId = extractGrokComConversationIdFromUrl(url);
            if (!conversationId) {
                return null;
            }
            const parsed = typeof data === 'string' ? JSON.parse(data) : data;
            return parseGrokComResponses(parsed, conversationId);
        }

        // Otherwise, parse as conversation data (x.com GraphQL)
        try {
            const parsed = typeof data === 'string' ? JSON.parse(data) : data;

            // Extract restId from URL if possible to ensure we use the same ID as the cache
            let conversationIdFromUrl: string | undefined;
            if (url) {
                try {
                    const urlObj = new URL(url);
                    const variablesStr = urlObj.searchParams.get('variables');
                    if (variablesStr) {
                        const variables = JSON.parse(variablesStr);
                        if (variables?.restId) {
                            conversationIdFromUrl = variables.restId;
                        }
                    }
                } catch {
                    // Fallback to regex
                    const match = url.match(/%22restId%22%3A%22(\d+)%22/);
                    if (match?.[1]) {
                        conversationIdFromUrl = match[1];
                    }
                }
            }

            return parseGrokResponse(parsed, conversationIdFromUrl);
        } catch (e) {
            logger.error('[Blackiya/Grok] Failed to parse data:', e);
            return null;
        }
    },

    /**
     * Format a filename for the downloaded JSON
     *
     * Format: {sanitized_title}_{YYYY-MM-DD_HH-MM-SS}
     *
     * @param data - The conversation data
     * @returns A sanitized filename (without .json extension)
     */
    formatFilename(data: ConversationData) {
        let title = data.title || '';

        // If no title, use a default with part of conversation ID
        if (!title.trim()) {
            const idPart =
                data.conversation_id && data.conversation_id.length >= 8
                    ? data.conversation_id.slice(0, 8)
                    : data.conversation_id || 'unknown';
            title = `grok_conversation_${idPart}`;
        }

        // Sanitize and truncate title
        let sanitizedTitle = sanitizeFilename(title);
        if (sanitizedTitle.length > MAX_TITLE_LENGTH) {
            sanitizedTitle = sanitizedTitle.slice(0, MAX_TITLE_LENGTH);
        }

        // Generate timestamp from update_time or create_time
        const timestamp = generateTimestamp(data.update_time || data.create_time);

        return `${sanitizedTitle}_${timestamp}`;
    },

    /**
     * Find injection target in Grok UI
     */
    getButtonInjectionTarget() {
        const selectors = ['[data-testid="grok-header"]', '[role="banner"]', 'header nav', 'header', 'body'];

        for (const selector of selectors) {
            const target = document.querySelector(selector);
            if (target) {
                return (target.parentElement || target) as HTMLElement;
            }
        }
        return null;
    },
};
