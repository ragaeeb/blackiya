/**
 * Gemini Platform Adapter - With Title Support (Enhanced Logging)
 *
 * Enhancements:
 * 1. Intercepts MaZiqc RPC calls to capture conversation titles
 * 2. Caches title mappings (conversationId -> title)
 * 3. Uses cached titles when building ConversationData
 * 4. Enhanced logging to debug title extraction
 */

import { GEMINI_RPC_IDS } from '@/platforms/constants';
import type { LLMPlatform, PlatformReadiness } from '@/platforms/types';
import { generateTimestamp, sanitizeFilename } from '@/utils/download';
import type { BatchexecuteResult } from '@/utils/google-rpc';
import { parseBatchexecuteResponse } from '@/utils/google-rpc';
import { hashText } from '@/utils/hash';
import { logger } from '@/utils/logger';
import type { ConversationData, MessageNode } from '@/utils/types';

const MAX_TITLE_LENGTH = 80;

import { LRUCache } from '@/utils/lru-cache';

/**
 * We keep a small cache of message-titles to apply them
 * if they arrive *before* the message data.
 */
const conversationTitles = new LRUCache<string, string>(50);

/**
 * We also keep a reference to active conversations so we can update
 * their titles retroactively if the title arrives *after* the data.
 */
const activeConversations = new LRUCache<string, ConversationData>(50);

/**
 * Parse the MaZiqc response to extract conversation titles
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Complex parsing logic required for platform
function parseTitlesResponse(data: string, url: string): Map<string, string> | null {
    try {
        logger.info('[Blackiya/Gemini/Titles] Attempting to parse titles from:', url);

        const rpcResults = parseBatchexecuteResponse(data);

        // Find the MaZiqc result
        const titleRpc = rpcResults.find((res) => res.rpcId === GEMINI_RPC_IDS.TITLES);

        if (!titleRpc || !titleRpc.payload) {
            logger.debug('[Blackiya/Gemini/Titles] No MaZiqc RPC result found');
            return null;
        }

        // 5. Parse the payload
        const payload = JSON.parse(titleRpc.payload);

        // 6. Extract conversation list
        // Structure: [null, "token", [[conversationData], ...]]
        if (!Array.isArray(payload) || payload.length < 3) {
            return null;
        }

        const conversationList = payload?.[2];
        if (!Array.isArray(conversationList)) {
            return null;
        }

        logger.info('[Blackiya/Gemini/Titles] Found conversation list with', conversationList.length, 'entries');

        const titles = new Map<string, string>();

        // 7. Each conversation entry: ["c_id", "title", null, null, null, [timestamp], ...]
        for (const conv of conversationList) {
            if (!Array.isArray(conv) || conv.length < 2) {
                continue;
            }

            let [convId, title] = conv;

            // Normalize ID (remove c_ prefix)
            if (typeof convId === 'string' && convId.startsWith('c_')) {
                convId = convId.slice(2);
            }

            if (typeof convId === 'string' && typeof title === 'string') {
                titles.set(convId, title);

                // Retroactively update active conversation
                const activeObj = activeConversations.get(convId);
                if (activeObj?.title && activeObj.title !== title) {
                    activeObj.title = title;
                    logger.info(`[Blackiya/Gemini/Titles] Updated: ${convId} -> "${title}"`);
                }
            }
        }

        return titles;
    } catch (e) {
        logger.error('[Blackiya/Gemini/Titles] Failed to parse titles:', e);
        return null;
    }
}

/**
 * Check if a URL is a MaZiqc (conversation list) endpoint
 */
function isTitlesEndpoint(url: string): boolean {
    const isTitles = url.includes('rpcids=MaZiqc');
    if (isTitles) {
        logger.info('[Blackiya/Gemini/Titles] Detected titles endpoint');
    }
    return isTitles;
}

/**
 * Finds the valid conversation RPC from a list of batchexecute results
 */
function findConversationRpc(
    results: BatchexecuteResult[],
    isConversationPayload?: (payload: any) => boolean,
): { rpcId: string; payload: any } | null {
    // Try to find by ID or heuristic
    const conversationRes = results.find((res) => {
        if (!res.payload) {
            return false;
        }
        if (res.rpcId === GEMINI_RPC_IDS.CONVERSATION) {
            return true;
        }

        try {
            const payload = JSON.parse(res.payload);
            return isConversationPayload?.(payload);
        } catch {
            return false;
        }
    });

    if (conversationRes?.payload) {
        try {
            const payload = JSON.parse(conversationRes.payload);
            logger.info(`[Blackiya/Gemini] Found conversation data in RPC ID: ${conversationRes.rpcId}`);
            return { rpcId: conversationRes.rpcId, payload };
        } catch {}
    }

    return null;
}

/**
 * Parses the conversation payload into Blackiya's standardized ConversationData
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Helper function logic is complex but necessary
function parseConversationPayload(
    payload: any,
    titlesCache: LRUCache<string, string>,
    activeConvos: LRUCache<string, ConversationData>,
): ConversationData | null {
    // Navigate to conversation data
    const conversationRoot = payload[0]?.[0];
    if (!conversationRoot || !Array.isArray(conversationRoot)) {
        logger.info('[Blackiya/Gemini] Invalid conversation root structure');
        return null;
    }

    // Extract IDs
    const idArray = conversationRoot[0];
    let conversationId = Array.isArray(idArray) ? idArray[0] : null;

    if (conversationId && typeof conversationId === 'string' && conversationId.startsWith('c_')) {
        conversationId = conversationId.slice(2);
    }

    logger.info('[Blackiya/Gemini] Extracted conversation ID:', conversationId);

    // Get title from cache or use default
    const conversationTitle =
        conversationId && titlesCache.has(conversationId) ? titlesCache.get(conversationId)! : 'Gemini Conversation';

    logger.info('[Blackiya/Gemini] Title lookup:', {
        conversationId,
        cached: conversationId ? titlesCache.has(conversationId) : false,
        title: conversationTitle,
    });

    // Extract messages
    const parsedMessages: any[] = [];

    // Recursive text extractor
    const extractText = (node: any): string => {
        if (typeof node === 'string') {
            return node;
        }
        if (!Array.isArray(node) || node.length === 0) {
            return '';
        }

        // Specific structure for user message content sometimes: [null, null, "text"]
        if (node.length >= 3 && node[0] === null && typeof node[2] === 'string') {
            return node[2];
        }

        return extractText(node[0]);
    };

    // User message (index 2)
    const userSlot = conversationRoot[2];
    if (userSlot && Array.isArray(userSlot)) {
        const rawUserContent = extractText(userSlot);
        if (rawUserContent) {
            parsedMessages.push({
                role: 'user',
                content: rawUserContent,
            });
        }
    }

    // Assistant message (index 3)
    const assistantSlot = conversationRoot[3];
    const assistantCandidate = assistantSlot?.[0]?.[0];

    if (Array.isArray(assistantCandidate)) {
        // Response text is at index 1 -> [0]
        const textParts = assistantCandidate[1];
        const assistantContent = Array.isArray(textParts) ? (textParts[0] as string) || '' : '';

        // Extract reasoning/thoughts (index 37 -> [0] -> [0])
        const reasoningData = assistantCandidate[37];
        const thinkingText = reasoningData?.[0]?.[0];

        const thoughts: any[] = [];
        if (typeof thinkingText === 'string' && thinkingText.length > 0) {
            const sections = thinkingText.split(/\n\*\*([^*]+)\*\*\n/);
            // sections[0] is usually empty or prelude; pairs follow: title, content
            for (let i = 1; i < sections.length; i += 2) {
                const title = sections[i]?.trim();
                const content = sections[i + 1]?.trim();
                if (title && content) {
                    thoughts.push({
                        summary: title,
                        content,
                        chunks: [],
                        finished: true,
                    });
                }
            }
        }

        if (assistantContent || thoughts.length > 0) {
            parsedMessages.push({
                role: 'assistant',
                content: assistantContent,
                thoughts: thoughts.length > 0 ? thoughts : undefined,
            });
        }
    }

    // Build mapping
    const mapping: Record<string, MessageNode> = {};

    // Extract model name from assistantSlot[21] if available
    let modelName = 'gemini-2.0';
    if (conversationRoot[3] && Array.isArray(conversationRoot[3]) && conversationRoot[3].length > 21) {
        const modelSlug = conversationRoot[3][21];
        if (typeof modelSlug === 'string') {
            modelName = `gemini-${modelSlug.toLowerCase().replace(/\s+/g, '-')}`;
            logger.info('[Blackiya/Gemini] Extracted model name:', modelName);
        }
    }

    parsedMessages.forEach((msg, index) => {
        const id = `segment-${index}`;

        mapping[id] = {
            id,
            message: {
                id,
                author: {
                    role: msg.role,
                    name: msg.role === 'user' ? 'User' : 'Gemini',
                    metadata: {},
                },
                content: {
                    content_type: msg.thoughts ? 'thoughts' : 'text',
                    parts: [msg.content],
                    thoughts: msg.thoughts,
                },
                create_time: Date.now() / 1000,
                update_time: Date.now() / 1000,
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
            parent: index === 0 ? null : `segment-${index - 1}`,
            children: index < parsedMessages.length - 1 ? [`segment-${index + 1}`] : [],
        };
    });

    logger.info('[Blackiya/Gemini] Successfully parsed conversation with', Object.keys(mapping).length, 'messages');

    const conversationData: ConversationData = {
        title: conversationTitle, // Use cached title instead of default
        create_time: Date.now() / 1000,
        update_time: Date.now() / 1000,
        conversation_id: conversationId || 'unknown',
        mapping,
        current_node: `segment-${Math.max(0, parsedMessages.length - 1)}`,
        is_archived: false,
        safe_urls: [],
        blocked_urls: [],
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        default_model_slug: modelName,
    };

    // Store in active conversations map for potential retroactive title updates
    if (conversationId) {
        activeConvos.set(conversationId, conversationData);
    }

    return conversationData;
}

function evaluateGeminiReadiness(data: ConversationData): PlatformReadiness {
    const messages = Object.values(data.mapping)
        .map((node) => node.message)
        .filter(
            (message): message is NonNullable<MessageNode['message']> =>
                !!message && message.author.role === 'assistant',
        )
        .sort((left, right) => {
            const leftTs = left.update_time ?? left.create_time ?? 0;
            const rightTs = right.update_time ?? right.create_time ?? 0;
            return leftTs - rightTs;
        });

    if (messages.length === 0) {
        return {
            ready: false,
            terminal: false,
            reason: 'assistant-missing',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    if (messages.some((message) => message.status === 'in_progress')) {
        return {
            ready: false,
            terminal: false,
            reason: 'assistant-in-progress',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    const latest = messages[messages.length - 1];
    const latestText = (latest.content.parts ?? []).filter((part): part is string => typeof part === 'string').join('');
    const normalized = latestText.trim().normalize('NFC');

    if (normalized.length === 0) {
        return {
            ready: false,
            terminal: true,
            reason: 'assistant-text-missing',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    if (latest.status !== 'finished_successfully' || latest.end_turn !== true) {
        return {
            ready: false,
            terminal: true,
            reason: 'assistant-latest-text-not-terminal-turn',
            contentHash: null,
            latestAssistantTextLength: normalized.length,
        };
    }

    return {
        ready: true,
        terminal: true,
        reason: 'terminal',
        contentHash: hashText(normalized),
        latestAssistantTextLength: normalized.length,
    };
}

export const geminiAdapter: LLMPlatform = {
    name: 'Gemini',
    urlMatchPattern: 'https://gemini.google.com/*',

    // Match ANY batchexecute endpoint (both conversation data and titles)
    // Match batchexecute endpoints containing specific RPC IDs:
    // hNvQHb (Conversation Data) OR MaZiqc (Conversation Titles)
    apiEndpointPattern: /\/_\/BardChatUi\/data\/batchexecute.*\?.*rpcids=.*(hNvQHb|MaZiqc)/,
    completionTriggerPattern: /\/_\/BardChatUi\/data\/batchexecute.*\?.*rpcids=.*hNvQHb/,

    isPlatformUrl(url: string): boolean {
        return url.includes('gemini.google.com');
    },

    extractConversationId(url: string): string | null {
        if (!this.isPlatformUrl(url)) {
            return null;
        }

        const appMatch = url.match(/\/app\/([a-zA-Z0-9_-]+)/i);
        if (appMatch) {
            return appMatch[1];
        }

        const shareMatch = url.match(/\/share\/([a-zA-Z0-9_-]+)/i);
        if (shareMatch) {
            return shareMatch[1];
        }
        return null;
    },

    extractConversationIdFromUrl(_url: string): string | null {
        // Gemini batchexecute URLs do not reliably contain the conversation ID.
        // We fall back to the currently active conversation ID from the page URL.
        return null;
    },

    parseInterceptedData(data: string, url: string): ConversationData | null {
        // Check if this is a titles endpoint
        if (isTitlesEndpoint(url)) {
            const titles = parseTitlesResponse(data, url);
            if (titles) {
                // Merge into global cache
                for (const [id, title] of titles) {
                    conversationTitles.set(id, title);
                }
                logger.info(`[Blackiya/Gemini] Title cache now contains ${conversationTitles.size} entries`);

                // Log current cache contents for debugging
                logger.info(
                    '[Blackiya/Gemini] Current cached conversation IDs:',
                    Array.from(conversationTitles.keys()).slice(0, 5),
                );
            } else {
                logger.info('[Blackiya/Gemini/Titles] Failed to extract titles from this response');
            }
            // Don't return ConversationData for title endpoints
            return null;
        }

        // Otherwise, parse as conversation data
        try {
            logger.info('[Blackiya/Gemini] Attempting to parse response from:', url);

            const rpcResults = parseBatchexecuteResponse(data);

            const conversationRpc = findConversationRpc(rpcResults, this.isConversationPayload);
            if (!conversationRpc) {
                logger.info('[Blackiya/Gemini] No RPC result with conversation data found');
                return null;
            }

            logger.info(`[Blackiya/Gemini] Using RPC ID: ${conversationRpc.rpcId}`);

            return parseConversationPayload(conversationRpc.payload, conversationTitles, activeConversations);
        } catch (e) {
            logger.error('[Blackiya/Gemini] Failed to parse:', e);
            if (e instanceof Error) {
                logger.error('[Blackiya/Gemini] Error stack:', e.stack);
            }
            return null;
        }
    },

    /**
     * Helper to detect if a payload contains conversation data
     */
    isConversationPayload(payload: any): boolean {
        try {
            if (!Array.isArray(payload) || payload.length === 0) {
                return false;
            }

            const level1 = payload[0];
            if (!Array.isArray(level1) || level1.length === 0) {
                return false;
            }

            const conversationRoot = level1[0];
            if (!Array.isArray(conversationRoot) || conversationRoot.length < 3) {
                return false;
            }

            const idArray = conversationRoot[0];
            if (!Array.isArray(idArray) || idArray.length < 2) {
                return false;
            }

            const firstId = idArray[0];
            if (typeof firstId === 'string' && (firstId.startsWith('c_') || /^[a-f0-9]+$/i.test(firstId))) {
                return true;
            }

            return false;
        } catch {
            return false;
        }
    },

    formatFilename(data: ConversationData): string {
        const title = data.title || 'Gemini_Conversation';
        const sanitizedTitle = sanitizeFilename(title).slice(0, MAX_TITLE_LENGTH);
        const timestamp = generateTimestamp(data.update_time);
        return `${sanitizedTitle}_${timestamp}`;
    },

    getButtonInjectionTarget(): HTMLElement | null {
        const selectors = [
            'header [aria-haspopup="menu"]',
            'header .flex-1.overflow-hidden',
            'header nav',
            '.chat-app-header',
            'header',
            '[role="banner"]',
            'body',
        ];

        for (const selector of selectors) {
            const target = document.querySelector(selector);
            if (target) {
                return (target.parentElement || target) as HTMLElement;
            }
        }
        return null;
    },

    evaluateReadiness(data: ConversationData) {
        return evaluateGeminiReadiness(data);
    },
};
