/**
 * Gemini Platform Adapter - FIXED VERSION
 *
 * Key fixes:
 * 1. Changed apiEndpointPattern to match ANY batchexecute (no RPC ID filter)
 * 2. Added dynamic RPC ID detection during parsing
 * 3. Fixed data extraction to handle the actual response structure
 * 4. Added better error logging with actual structure inspection
 */

import { generateTimestamp, sanitizeFilename } from '../utils/download';
import type { ConversationData, MessageNode } from '../utils/types';
import type { LLMPlatform } from './types';

const MAX_TITLE_LENGTH = 80;

export const geminiAdapter: LLMPlatform = {
    name: 'Gemini',
    urlMatchPattern: 'https://gemini.google.com/*',

    // FIXED: Match ANY batchexecute endpoint, we'll validate RPC ID during parsing
    apiEndpointPattern: /\/_\/BardChatUi\/data\/batchexecute/,

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
            console.log('[Blackiya/Gemini] First element structure:', wrapper[0]);

            // 4. FIXED: Try to find ANY RPC result that contains conversation data
            // The structure is: [["wrb.fr", "RPC_ID", "JSON_STRING", ...], ...]
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
                            // Check if this payload contains conversation-like data
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
            console.log('[Blackiya/Gemini] Payload structure:', JSON.stringify(payload, null, 2).slice(0, 500));

            // 6. Navigate to conversation data
            const conversationRoot = payload[0]?.[0];
            if (!conversationRoot || !Array.isArray(conversationRoot)) {
                console.log('[Blackiya/Gemini] Invalid conversation root structure');
                return null;
            }

            console.log('[Blackiya/Gemini] ConversationRoot length:', conversationRoot.length);
            console.log('[Blackiya/Gemini] ConversationRoot[0] (IDs):', conversationRoot[0]);
            console.log('[Blackiya/Gemini] ConversationRoot[1]:', conversationRoot[1]);
            console.log(
                '[Blackiya/Gemini] ConversationRoot[2] (User slot):',
                JSON.stringify(conversationRoot[2])?.slice(0, 200),
            );
            console.log(
                '[Blackiya/Gemini] ConversationRoot[3] (Assistant slot):',
                JSON.stringify(conversationRoot[3])?.slice(0, 200),
            );
            console.log(
                '[Blackiya/Gemini] ConversationRoot[4] (if exists):',
                conversationRoot[4] ? JSON.stringify(conversationRoot[4])?.slice(0, 200) : 'N/A',
            );

            // Check for model info in the root payload
            console.log('[Blackiya/Gemini] Checking for model info...');

            // Look for title in payload structure
            // Title might be at payload[0][0] or payload level
            const conversationTitle = 'Gemini Conversation';

            if (payload[0]) {
                console.log('[Blackiya/Gemini] payload[0] length:', payload[0].length);

                // Check various indices for title
                for (let i = 0; i < Math.min(5, payload[0].length); i++) {
                    const item = payload[0][i];
                    if (
                        typeof item === 'string' &&
                        item.length > 0 &&
                        item.length < 200 &&
                        !item.startsWith('c_') &&
                        !item.startsWith('r_')
                    ) {
                        console.log(`[Blackiya/Gemini] payload[0][${i}] (potential title):`, item);
                    }
                }
            }

            // Also check root level
            if (payload[1]) {
                console.log('[Blackiya/Gemini] payload[1]:', payload[1]);
            }
            if (payload[2]) {
                console.log('[Blackiya/Gemini] payload[2]:', payload[2]);
            }

            // Also check assistantSlot for model info
            if (conversationRoot[3] && Array.isArray(conversationRoot[3])) {
                const lastIndex = conversationRoot[3].length - 1;
                console.log(
                    '[Blackiya/Gemini] assistantSlot last element [' + lastIndex + ']:',
                    conversationRoot[3][lastIndex],
                );
            }

            // Extract IDs
            const idArray = conversationRoot[0];
            let conversationId = Array.isArray(idArray) ? idArray[0] : null;

            if (conversationId && typeof conversationId === 'string' && conversationId.startsWith('c_')) {
                conversationId = conversationId.slice(2);
            }

            console.log('[Blackiya/Gemini] Extracted conversation ID:', conversationId);

            // 7. Extract messages
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
            // Structure: [[["rc_id", ["text"], null, ..., reasoningAtIndex37]]]
            const assistantSlot = conversationRoot[3];
            if (assistantSlot && Array.isArray(assistantSlot)) {
                console.log('[Blackiya/Gemini] assistantSlot length:', assistantSlot.length);

                const candidate = assistantSlot[0];
                if (candidate && Array.isArray(candidate)) {
                    console.log('[Blackiya/Gemini] candidate length:', candidate.length);

                    // The candidate is actually wrapped in another array
                    // Structure: [["rc_id", ["text"], null, ..., reasoningAtIndex37]]
                    const actualCandidate = candidate[0];
                    if (actualCandidate && Array.isArray(actualCandidate)) {
                        console.log('[Blackiya/Gemini] actualCandidate length:', actualCandidate.length);

                        // Log all indices to find thinking data
                        console.log('[Blackiya/Gemini] actualCandidate structure:');
                        for (let i = 0; i < Math.min(actualCandidate.length, 50); i++) {
                            const item = actualCandidate[i];
                            if (item !== null && item !== undefined) {
                                const preview =
                                    typeof item === 'string'
                                        ? item.slice(0, 100)
                                        : Array.isArray(item)
                                          ? `Array(${item.length})`
                                          : typeof item === 'object'
                                            ? 'Object'
                                            : item;
                                console.log(`  [${i}]:`, preview);
                            }
                        }

                        let assistantContent = '';

                        // Response text is at index 1, nested in an array
                        const contentNode = actualCandidate[1];
                        if (Array.isArray(contentNode) && contentNode.length > 0) {
                            if (typeof contentNode[0] === 'string') {
                                assistantContent = contentNode[0];
                            }
                        }

                        console.log('[Blackiya/Gemini] Assistant content length:', assistantContent.length);

                        // Extract reasoning/thoughts (index 37)
                        // Structure: reasoningData[0][0] = Full markdown string with thinking
                        const thoughts: any[] = [];
                        const reasoningData = actualCandidate[37];

                        console.log('[Blackiya/Gemini] Reasoning data exists:', !!reasoningData);

                        if (Array.isArray(reasoningData) && reasoningData.length > 0) {
                            console.log('[Blackiya/Gemini] Reasoning data length:', reasoningData.length);

                            // Get the full thinking text
                            const thinkingText = reasoningData[0]?.[0];

                            if (typeof thinkingText === 'string' && thinkingText.length > 0) {
                                console.log('[Blackiya/Gemini] Found thinking text, length:', thinkingText.length);

                                // Split by markdown headers (##** or **)
                                // Pattern: lines starting with **Title**
                                const sections = thinkingText.split(/\n\*\*([^*]+)\*\*\n/);

                                // sections[0] is empty or preamble
                                // sections[1] is first title, sections[2] is first content
                                // sections[3] is second title, sections[4] is second content, etc.

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

                                console.log('[Blackiya/Gemini] Parsed thinking sections:', thoughts.length);
                            } else {
                                console.log('[Blackiya/Gemini] No thinking text found in reasoningData[0][0]');
                            }
                        }

                        if (assistantContent || thoughts.length > 0) {
                            parsedMessages.push({
                                role: 'assistant',
                                content: assistantContent,
                                thoughts: thoughts.length > 0 ? thoughts : undefined,
                            });
                        }

                        console.log('[Blackiya/Gemini] Extracted assistant message:', {
                            contentLength: assistantContent.length,
                            thoughtsCount: thoughts.length,
                        });
                    } else {
                        console.log('[Blackiya/Gemini] actualCandidate is not an array or is null');
                    }
                }
            }

            // 8. Build mapping
            const mapping: Record<string, MessageNode> = {};

            // Extract model name from assistantSlot[21] if available
            let modelName = 'gemini-2.0';
            if (conversationRoot[3] && Array.isArray(conversationRoot[3]) && conversationRoot[3].length > 21) {
                const modelSlug = conversationRoot[3][21];
                if (typeof modelSlug === 'string') {
                    // Convert "3 Pro" to "gemini-3-pro"
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

            return {
                title: 'Gemini Conversation',
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
            // Check for the expected structure: [[[conversationRoot]]]
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

            // Check for ID array at index 0
            const idArray = conversationRoot[0];
            if (!Array.isArray(idArray) || idArray.length < 2) {
                return false;
            }

            // Check if first ID looks like a conversation ID (starts with c_ or is hex)
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
