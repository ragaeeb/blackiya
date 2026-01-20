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
import type { Author, ConversationData, Message, MessageContent, MessageNode } from '@/utils/types';

const MAX_TITLE_LENGTH = 80;

/**
 * Regex pattern to match a valid Grok conversation ID
 * Format: numeric string (e.g., "2013295304527827227")
 */
const CONVERSATION_ID_PATTERN = /^\d{10,20}$/;

/**
 * In-memory cache for conversation titles
 * Maps conversation ID (rest_id) to title
 */
const conversationTitles = new Map<string, string>();

/**
 * Track active conversation objects to allow retroactive title updates
 * Maps conversation ID -> ConversationData object reference
 */
const activeConversations = new Map<string, ConversationData>();

/**
 * Parse the GrokHistory response to extract conversation titles
 */
function parseTitlesResponse(data: string, url: string): Map<string, string> | null {
    try {
        console.log('[Blackiya/Grok/Titles] Attempting to parse titles from:', url);

        const parsed = JSON.parse(data);
        const historyData = parsed?.data?.grok_conversation_history;

        if (!historyData || !Array.isArray(historyData.items)) {
            console.log('[Blackiya/Grok/Titles] No conversation history items found');
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
                        console.log(
                            `[Blackiya/Grok/Titles] Retroactively updated title for active conversation: ${restId} -> "${title}"`,
                        );
                    }
                }
            }
        }

        console.log(`[Blackiya/Grok/Titles] Extracted ${titles.size} conversation titles`);
        return titles;
    } catch (e) {
        console.error('[Blackiya/Grok/Titles] Failed to parse titles:', e);
        return null;
    }
}

/**
 * Check if a URL is a GrokHistory (conversation list) endpoint
 */
function isTitlesEndpoint(url: string): boolean {
    const isTitles = url.includes('GrokHistory');
    if (isTitles) {
        console.log('[Blackiya/Grok/Titles] Detected titles endpoint');
    }
    return isTitles;
}

/**
 * Extract thinking/reasoning content from Grok message
 */

function extractThinkingContent(chatItem: any):
    | Array<{
          summary: string;
          content: string;
          chunks: string[];
          finished: boolean;
      }>
    | undefined {
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
}

/**
 * Determine sender type and create Author object
 */
function createAuthor(senderType: string): Author {
    if (senderType === 'User') {
        return {
            role: 'user',
            name: 'User',
            metadata: {},
        };
    }

    // Agent (Grok AI)
    return {
        role: 'assistant',
        name: 'Grok',
        metadata: {},
    };
}

/**
 * Parse Grok API response into ConversationData
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Complex parsing logic required for platform
function parseGrokResponse(data: any, conversationIdOverride?: string): ConversationData | null {
    try {
        const conversationData = data?.data?.grok_conversation_items_by_rest_id;
        if (!conversationData) {
            console.log('[Blackiya/Grok] No conversation data found in response');
            return null;
        }

        const items = conversationData.items;
        if (!Array.isArray(items) || items.length === 0) {
            console.log('[Blackiya/Grok] No conversation items found');
            return null;
        }

        // Extract conversation metadata
        const _isPinned = conversationData.is_pinned || false;
        const _cursor = conversationData.cursor || '';

        // Build the conversation mapping
        const mapping: Record<string, MessageNode> = {};
        let conversationId = '';
        let conversationTitle = 'Grok Conversation';
        let createTime = Date.now() / 1000;
        let updateTime = Date.now() / 1000;

        // Create root node
        const rootId = 'grok-root';
        mapping[rootId] = {
            id: rootId,
            message: null,
            parent: null,
            children: [],
        };

        let previousNodeId = rootId;

        // Process each chat item
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const chatItemId = item.chat_item_id;
            const createdAtMs = item.created_at_ms;
            const grokMode = item.grok_mode || 'Normal';
            const message = item.message || '';
            const senderType = item.sender_type || 'Agent';
            const isPartial = item.is_partial || false;

            // Extract conversation ID from first message
            if (i === 0) {
                // Priority 1: Use the override which comes from the URL restId
                if (conversationIdOverride) {
                    conversationId = conversationIdOverride;
                }
                // Priority 2: Use chat_item_id as fallback, though it may trigger cache mismatches
                else if (chatItemId) {
                    conversationId = chatItemId;
                }
            }

            // Extract title from first user message if available (fallback)
            if (i === 0 && senderType === 'User' && message && !conversationTitles.has(conversationId)) {
                const firstLine = message.split('\n')[0];
                if (firstLine && firstLine.length > 0 && firstLine.length < 100) {
                    conversationTitle = firstLine;
                }
            }

            // Update timestamps
            if (createdAtMs) {
                const timestamp = createdAtMs / 1000;
                if (i === 0) {
                    createTime = timestamp;
                }
                updateTime = Math.max(updateTime, timestamp);
            }

            // Create message content
            const thoughts = extractThinkingContent(item);
            const contentType = thoughts ? 'thoughts' : 'text';

            const content: MessageContent = {
                content_type: contentType,
                parts: [message],
                thoughts: thoughts,
            };

            // Create message
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
                    thinking_trace: item.thinking_trace || '',
                    ui_layout: item.ui_layout || {},
                },
                recipient: 'all',
                channel: null,
            };

            // Create message node
            const nodeId = chatItemId;
            mapping[nodeId] = {
                id: nodeId,
                message: messageObj,
                parent: previousNodeId,
                children: [],
            };

            // Update parent's children
            if (mapping[previousNodeId]) {
                mapping[previousNodeId].children.push(nodeId);
            }

            previousNodeId = nodeId;
        }

        // Get the last node ID
        const lastNodeId = items.length > 0 ? items[items.length - 1].chat_item_id : rootId;

        // Check if we have a cached title for this conversation
        if (conversationId && conversationTitles.has(conversationId)) {
            conversationTitle = conversationTitles.get(conversationId)!;
            console.log('[Blackiya/Grok] Using cached title:', conversationTitle);
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

        console.log('[Blackiya/Grok] Successfully parsed conversation with', Object.keys(mapping).length, 'nodes');
        return result;
    } catch (e) {
        console.error('[Blackiya/Grok] Failed to parse conversation:', e);
        if (e instanceof Error) {
            console.error('[Blackiya/Grok] Error stack:', e.stack);
        }
        return null;
    }
}

/**
 * Grok Platform Adapter
 *
 * Supports x.com Grok conversations
 */
export const grokAdapter: LLMPlatform = {
    name: 'Grok',

    urlMatchPattern: 'https://x.com/i/grok*',

    // Match BOTH the conversation endpoint AND the history endpoint
    apiEndpointPattern: /\/i\/api\/graphql\/[^/]+\/(GrokConversationItemsByRestId|GrokHistory)/,

    /**
     * Check if a URL belongs to Grok
     */
    isPlatformUrl(url: string): boolean {
        return url.includes('x.com/i/grok');
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
    extractConversationId(url: string): string | null {
        try {
            const urlObj = new URL(url);

            // Validate hostname
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
            if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
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
    parseInterceptedData(data: string | any, url: string): ConversationData | null {
        // Check if this is a titles endpoint
        if (isTitlesEndpoint(url)) {
            const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
            const titles = parseTitlesResponse(dataStr, url);
            if (titles) {
                // Merge into global cache
                for (const [id, title] of titles) {
                    conversationTitles.set(id, title);
                }
                console.log(`[Blackiya/Grok] Title cache now contains ${conversationTitles.size} entries`);
            } else {
                console.log('[Blackiya/Grok/Titles] Failed to extract titles from this response');
            }
            // Don't return ConversationData for title endpoints
            return null;
        }

        // Otherwise, parse as conversation data
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
            console.error('[Blackiya/Grok] Failed to parse data:', e);
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
    formatFilename(data: ConversationData): string {
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
    getButtonInjectionTarget(): HTMLElement | null {
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
