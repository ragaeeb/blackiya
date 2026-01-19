/**
 * Gemini Platform Adapter - With Title Support (Enhanced Logging)
 *
 * Enhancements:
 * 1. Intercepts MaZiqc RPC calls to capture conversation titles
 * 2. Caches title mappings (conversationId -> title)
 * 3. Uses cached titles when building ConversationData
 * 4. Enhanced logging to debug title extraction
 */

import { generateTimestamp, sanitizeFilename } from '../utils/download';
import type { ConversationData, MessageNode } from '../utils/types';
import type { LLMPlatform } from './types';

const MAX_TITLE_LENGTH = 80;

/**
 * In-memory cache for conversation titles
 * Maps normalized conversation ID (without c_ prefix) to title
 */
const conversationTitles = new Map<string, string>();

/**
 * Track active conversation objects to allow retroactive title updates
 * Maps conversation ID -> ConversationData object reference
 */
const activeConversations = new Map<string, ConversationData>();

/**
 * Parse the MaZiqc response to extract conversation titles
 */
function parseTitlesResponse(data: string, url: string): Map<string, string> | null {
    try {
        console.log('[Blackiya/Gemini/Titles] Attempting to parse titles from:', url);

        // 1. Strip security prefix
        const MAGIC_HEADER_REGEX = /^\s*\)\s*\]\s*\}\s*'/;
        const cleanedData = data.replace(MAGIC_HEADER_REGEX, '').trim();

        // 2. Find JSON array
        const startBracket = cleanedData.indexOf('[');
        if (startBracket === -1) {
            console.log('[Blackiya/Gemini/Titles] No JSON array found');
            return null;
        }

        // 3. Extract balanced JSON
        let balance = 0;
        let endBracket = -1;
        let insideString = false;
        let isEscaped = false;

        for (let i = startBracket; i < cleanedData.length; i++) {
            const char = cleanedData[i];

            if (isEscaped) {
                isEscaped = false;
                continue;
            }

            if (char === '\\') {
                isEscaped = true;
                continue;
            }

            if (char === '"') {
                insideString = !insideString;
                continue;
            }

            if (!insideString) {
                if (char === '[') {
                    balance++;
                } else if (char === ']') {
                    balance--;
                    if (balance === 0) {
                        endBracket = i;
                        break;
                    }
                }
            }
        }

        if (endBracket === -1) {
            console.log('[Blackiya/Gemini/Titles] Could not find balanced JSON array');
            return null;
        }

        const jsonStr = cleanedData.substring(startBracket, endBracket + 1);
        const wrapper = JSON.parse(jsonStr);

        if (!Array.isArray(wrapper) || wrapper.length === 0) {
            console.log('[Blackiya/Gemini/Titles] Wrapper is not an array or is empty');
            return null;
        }

        // 4. Find the MaZiqc result
        let rpcResult = null;
        for (const item of wrapper) {
            if (Array.isArray(item) && item.length >= 3 && item[0] === 'wrb.fr' && item[1] === 'MaZiqc') {
                rpcResult = item;
                // console.log('[Blackiya/Gemini/Titles] Found MaZiqc result');
                break;
            }
        }

        if (!rpcResult) {
            // console.log('[Blackiya/Gemini/Titles] No MaZiqc RPC result found in wrapper');
            return null;
        }

        // 5. Parse the payload
        const payloadStr = rpcResult[2];
        if (typeof payloadStr !== 'string') {
            return null;
        }

        const payload = JSON.parse(payloadStr);

        // 6. Extract conversation list
        // Structure: [null, "token", [[conversationData], ...]]
        if (!Array.isArray(payload) || payload.length < 3) {
            return null;
        }

        const conversationList = payload[2];
        if (!Array.isArray(conversationList)) {
            return null;
        }

        console.log('[Blackiya/Gemini/Titles] Found conversation list with', conversationList.length, 'entries');

        const titles = new Map<string, string>();

        // 7. Each conversation entry: ["c_id", "title", null, null, null, [timestamp], ...]
        for (const conv of conversationList) {
            if (Array.isArray(conv) && conv.length >= 2) {
                let convId = conv[0];
                const title = conv[1];

                // Normalize ID (remove c_ prefix)
                if (typeof convId === 'string' && convId.startsWith('c_')) {
                    convId = convId.slice(2);
                }

                if (typeof convId === 'string' && typeof title === 'string') {
                    titles.set(convId, title);

                    // Retroactively update any active conversation object
                    if (activeConversations.has(convId)) {
                        const activeObj = activeConversations.get(convId);
                        if (activeObj && activeObj.title !== title) {
                            activeObj.title = title;
                            console.log(
                                `[Blackiya/Gemini/Titles] Retroactively updated title for active conversation: ${convId} -> "${title}"`,
                            );
                        }
                    }
                }
            }
        }

        return titles;
    } catch (e) {
        console.error('[Blackiya/Gemini/Titles] Failed to parse titles:', e);
        return null;
    }
}

/**
 * Check if a URL is a MaZiqc (conversation list) endpoint
 */
function isTitlesEndpoint(url: string): boolean {
    const isTitles = url.includes('rpcids=MaZiqc');
    if (isTitles) {
        console.log('[Blackiya/Gemini/Titles] Detected titles endpoint');
    }
    return isTitles;
}

export const geminiAdapter: LLMPlatform = {
    name: 'Gemini',
    urlMatchPattern: 'https://gemini.google.com/*',

    // Match ANY batchexecute endpoint (both conversation data and titles)
    // Match batchexecute endpoints containing specific RPC IDs:
    // hNvQHb (Conversation Data) OR MaZiqc (Conversation Titles)
    apiEndpointPattern: /\/_\/BardChatUi\/data\/batchexecute.*\?.*rpcids=.*(hNvQHb|MaZiqc)/,

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

    parseInterceptedData(data: string, url: string): ConversationData | null {
        // Check if this is a titles endpoint
        if (isTitlesEndpoint(url)) {
            const titles = parseTitlesResponse(data, url);
            if (titles) {
                // Merge into global cache
                for (const [id, title] of titles) {
                    conversationTitles.set(id, title);
                }
                console.log(`[Blackiya/Gemini] Title cache now contains ${conversationTitles.size} entries`);

                // Log current cache contents for debugging
                console.log(
                    '[Blackiya/Gemini] Current cached conversation IDs:',
                    Array.from(conversationTitles.keys()).slice(0, 5),
                );
            } else {
                console.log('[Blackiya/Gemini/Titles] Failed to extract titles from this response');
            }
            // Don't return ConversationData for title endpoints
            return null;
        }

        // Otherwise, parse as conversation data
        try {
            console.log('[Blackiya/Gemini] Attempting to parse response from:', url);

            // 1. Strip security prefix
            const MAGIC_HEADER_REGEX = /^\s*\)\s*\]\s*\}\s*'/;
            const cleanedData = data.replace(MAGIC_HEADER_REGEX, '').trim();

            // 2. Find JSON array
            const startBracket = cleanedData.indexOf('[');
            if (startBracket === -1) {
                console.log('[Blackiya/Gemini] No JSON array found');
                return null;
            }

            // 3. Extract balanced JSON
            let balance = 0;
            let endBracket = -1;
            let insideString = false;
            let isEscaped = false;

            for (let i = startBracket; i < cleanedData.length; i++) {
                const char = cleanedData[i];

                if (isEscaped) {
                    isEscaped = false;
                    continue;
                }

                if (char === '\\') {
                    isEscaped = true;
                    continue;
                }

                if (char === '"') {
                    insideString = !insideString;
                    continue;
                }

                if (!insideString) {
                    if (char === '[') {
                        balance++;
                    } else if (char === ']') {
                        balance--;
                        if (balance === 0) {
                            endBracket = i;
                            break;
                        }
                    }
                }
            }

            if (endBracket === -1) {
                console.log('[Blackiya/Gemini] Could not find balanced JSON array');
                return null;
            }

            const jsonStr = cleanedData.substring(startBracket, endBracket + 1);
            const wrapper = JSON.parse(jsonStr);

            if (!Array.isArray(wrapper) || wrapper.length === 0) {
                console.log('[Blackiya/Gemini] Wrapper is not an array or is empty');
                return null;
            }

            console.log('[Blackiya/Gemini] Wrapper array length:', wrapper.length);

            // 4. Find conversation data RPC result
            let rpcResult = null;
            let foundRpcId = null;

            for (const item of wrapper) {
                if (Array.isArray(item) && item.length >= 3 && item[0] === 'wrb.fr') {
                    const rpcId = item[1];
                    const payloadStr = item[2];

                    console.log(`[Blackiya/Gemini] Checking RPC ID: ${rpcId}`);

                    if (typeof payloadStr === 'string') {
                        try {
                            const testPayload = JSON.parse(payloadStr);
                            if (this.isConversationPayload(testPayload)) {
                                console.log(`[Blackiya/Gemini] Found conversation data in RPC ID: ${rpcId}`);
                                rpcResult = item;
                                foundRpcId = rpcId;
                                break;
                            }
                        } catch (e) {}
                    }
                }
            }

            if (!rpcResult) {
                console.log('[Blackiya/Gemini] No RPC result with conversation data found');
                return null;
            }

            console.log(`[Blackiya/Gemini] Using RPC ID: ${foundRpcId}`);

            // 5. Parse the payload
            const payload = JSON.parse(rpcResult[2]);

            // 6. Navigate to conversation data
            const conversationRoot = payload[0]?.[0];
            if (!conversationRoot || !Array.isArray(conversationRoot)) {
                console.log('[Blackiya/Gemini] Invalid conversation root structure');
                return null;
            }

            // Extract IDs
            const idArray = conversationRoot[0];
            let conversationId = Array.isArray(idArray) ? idArray[0] : null;

            if (conversationId && typeof conversationId === 'string' && conversationId.startsWith('c_')) {
                conversationId = conversationId.slice(2);
            }

            console.log('[Blackiya/Gemini] Extracted conversation ID:', conversationId);

            // 7. Get title from cache or use default
            const conversationTitle =
                conversationId && conversationTitles.has(conversationId)
                    ? conversationTitles.get(conversationId)!
                    : 'Gemini Conversation';

            console.log('[Blackiya/Gemini] Looking up title for ID:', conversationId);
            console.log(
                '[Blackiya/Gemini] Title cache has this ID:',
                conversationId ? conversationTitles.has(conversationId) : false,
            );
            console.log('[Blackiya/Gemini] Using title:', conversationTitle);

            // 8. Extract messages
            const parsedMessages: any[] = [];

            const extractText = (node: any): string => {
                if (typeof node === 'string') {
                    return node;
                }
                if (Array.isArray(node)) {
                    if (node.length > 0) {
                        if (node.length >= 3 && node[0] === null && typeof node[2] === 'string') {
                            return node[2];
                        }
                        return extractText(node[0]);
                    }
                }
                return '';
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
            if (assistantSlot && Array.isArray(assistantSlot)) {
                const candidate = assistantSlot[0];
                if (candidate && Array.isArray(candidate)) {
                    const actualCandidate = candidate[0];
                    if (actualCandidate && Array.isArray(actualCandidate)) {
                        let assistantContent = '';

                        // Response text is at index 1
                        const contentNode = actualCandidate[1];
                        if (Array.isArray(contentNode) && contentNode.length > 0) {
                            if (typeof contentNode[0] === 'string') {
                                assistantContent = contentNode[0];
                            }
                        }

                        // Extract reasoning/thoughts (index 37)
                        const thoughts: any[] = [];
                        const reasoningData = actualCandidate[37];

                        if (Array.isArray(reasoningData) && reasoningData.length > 0) {
                            const thinkingText = reasoningData[0]?.[0];

                            if (typeof thinkingText === 'string' && thinkingText.length > 0) {
                                const sections = thinkingText.split(/\n\*\*([^*]+)\*\*\n/);

                                for (let i = 1; i < sections.length; i += 2) {
                                    const title = sections[i]?.trim();
                                    const content = sections[i + 1]?.trim();

                                    if (title && content) {
                                        thoughts.push({
                                            summary: title,
                                            content: content,
                                            chunks: [],
                                            finished: true,
                                        });
                                    }
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
                }
            }

            // 9. Build mapping
            const mapping: Record<string, MessageNode> = {};

            // Extract model name from assistantSlot[21] if available
            let modelName = 'gemini-2.0';
            if (conversationRoot[3] && Array.isArray(conversationRoot[3]) && conversationRoot[3].length > 21) {
                const modelSlug = conversationRoot[3][21];
                if (typeof modelSlug === 'string') {
                    modelName = 'gemini-' + modelSlug.toLowerCase().replace(/\s+/g, '-');
                    console.log('[Blackiya/Gemini] Extracted model name:', modelName);
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

            console.log(
                '[Blackiya/Gemini] Successfully parsed conversation with',
                Object.keys(mapping).length,
                'messages',
            );

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
                activeConversations.set(conversationId, conversationData);
            }

            return conversationData;
        } catch (e) {
            console.error('[Blackiya/Gemini] Failed to parse:', e);
            if (e instanceof Error) {
                console.error('[Blackiya/Gemini] Error stack:', e.stack);
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
};
