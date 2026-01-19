/**
 * Gemini Platform Adapter
 *
 * Implements the LLMPlatform interface for gemini.google.com.
 * Handles the custom Google "batchexecute" format and extracts conversation data.
 *
 * @module platforms/gemini
 */

import { generateTimestamp, sanitizeFilename } from '../utils/download';
import type { ConversationData, MessageNode } from '../utils/types';
import type { LLMPlatform } from './types';

const MAX_TITLE_LENGTH = 80;

/**
 * Gemini Platform Adapter
 */
export const geminiAdapter: LLMPlatform = {
    name: 'Gemini',

    urlMatchPattern: 'https://gemini.google.com/*',

    // Match any batchexecute endpoint (will validate rpcids during parsing if needed)
    apiEndpointPattern: /\/batchexecute/,

    /**
     * Check if a URL belongs to Gemini
     */
    isPlatformUrl(url: string): boolean {
        return url.includes('gemini.google.com');
    },

    /**
     * Extract conversation ID from Gemini URL
     * Format: https://gemini.google.com/app/{id}
     */
    extractConversationId(url: string): string | null {
        if (!this.isPlatformUrl(url)) {
            return null;
        }

        // Try /app/{id}
        const appMatch = url.match(/\/app\/([a-zA-Z0-9_-]+)/i);
        if (appMatch) {
            return appMatch[1];
        }

        // Try share URL
        const shareMatch = url.match(/\/share\/([a-zA-Z0-9_-]+)/i);
        if (shareMatch) {
            return shareMatch[1];
        }

        return null;
    },

    /**
     * Parse the custom Google "batchexecute" response format
     *
     * Format:
     * )]}'
     * [length]
     * [["wrb.fr", "rpcId", "json_payload_string", ...], ...]
     */

    parseInterceptedData(data: string, _url: string): ConversationData | null {
        try {
            // 1. Strip the security prefix if present
            // 1. Strip the security prefix if present
            // Handle standard )]}' and split versions like )\n]\n}'
            const MAGIC_HEADER_REGEX = /^\s*\)\s*\]\s*\}\s*'/;
            const cleanedData = data.replace(MAGIC_HEADER_REGEX, '').trim();

            // 2. Find the JSON array part
            // The format is often: [length]\n[array]
            const startBracket = cleanedData.indexOf('[');

            if (startBracket === -1) {
                return null;
            }

            // Find the matching closing bracket by counting balance
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
                return null;
            }

            const jsonStr = cleanedData.substring(startBracket, endBracket + 1);
            const wrapper = JSON.parse(jsonStr);

            // 3. Find the RPC result for hNvQHb (Conversation Data)
            const rpcResult = (wrapper as any[]).find((item) => Array.isArray(item) && item[1] === 'hNvQHb');

            if (!rpcResult || !rpcResult[2]) {
                return null;
            }

            // 4. Parse the payload string (Double-JSON encoded)
            const payload = JSON.parse(rpcResult[2]);

            // 5. Navigate to conversation data
            // Structure based on reverse-engineering:
            // payload is [[[["c_id", "r_id"], null, [messages]]]]
            // payload[0][0] is the conversation root node: [["c_id", "r_id"], null, [messages]]
            const conversationRoot = payload[0]?.[0];

            if (!conversationRoot || !Array.isArray(conversationRoot)) {
                return null;
            }

            // Extract conversation ID from the first element: ["c_id", "r_id"]
            const idArray = conversationRoot[0];
            let conversationId = Array.isArray(idArray) ? idArray[0] : null;

            // Normalize ID: remove 'c_' prefix to match URL ID
            if (conversationId && typeof conversationId === 'string' && conversationId.startsWith('c_')) {
                conversationId = conversationId.slice(2);
            }

            // const responseId = idArray[1];

            // Temporary storage for message objects
            const parsedMessages: any[] = [];

            // Helper to extract text from nested structures
            const extractText = (node: any): string => {
                if (typeof node === 'string') {
                    return node;
                }
                if (Array.isArray(node)) {
                    if (node.length > 0) {
                        // Check for common patterns
                        // [null, 0, "Text"]
                        if (node.length >= 3 && node[0] === null && typeof node[2] === 'string') {
                            return node[2];
                        }
                        // [["Text"]] or ["Text"]
                        return extractText(node[0]);
                    }
                }
                return '';
            };

            // Parse User Message (Index 2)
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

            // Parse Assistant Message (Index 3 - Candidates)
            const assistantSlot = conversationRoot[3];
            if (assistantSlot && Array.isArray(assistantSlot)) {
                // Take the first candidate
                const candidate = assistantSlot[0];
                if (candidate && Array.isArray(candidate)) {
                    // Content is typically at index 1: ["Text"]
                    let assistantContent = '';
                    const contentNode = candidate[1];
                    if (Array.isArray(contentNode) && contentNode.length > 0) {
                        // Sometimes contentNode is just ["Text"]
                        if (typeof contentNode[0] === 'string') {
                            assistantContent = contentNode[0];
                        }
                    }

                    // Reasoning is at index 37
                    const thoughts: any[] = [];
                    const reasoningData = candidate[37];

                    if (Array.isArray(reasoningData)) {
                        for (let i = 0; i < reasoningData.length; i += 2) {
                            const titleItem = reasoningData[i];
                            const bodyItem = reasoningData[i + 1];

                            if (titleItem && bodyItem) {
                                // Structure: [null, [null, 0, "Text", ...]]
                                const title = extractText(titleItem[1]);
                                const content = extractText(bodyItem[1]);

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

            // Reconstruct mapping from message list
            const mapping: Record<string, MessageNode> = {};

            if (parsedMessages.length > 0) {
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
                            create_time: generateTimestamp(),
                            update_time: generateTimestamp(),
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
            } else {
                // Fallback: If strict parsing failed, maybe try the legacy loop over index 2?
                // But considering index 2 was just user input in array form, treating it as a list of messages was wrong.
                // We'll leave it empty to avoid "1", "null" garbage.
            }

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
                default_model_slug: '',
            };
        } catch (e) {
            console.error('[Blackiya] Failed to parse Gemini batchexecute response:', e);
            return null;
        }
    },

    /**
     * Format filename for Gemini
     */
    formatFilename(data: ConversationData): string {
        const title = data.title || 'Gemini_Conversation';
        const sanitizedTitle = sanitizeFilename(title).slice(0, MAX_TITLE_LENGTH);
        const timestamp = generateTimestamp(data.update_time);
        return `${sanitizedTitle}_${timestamp}`;
    },

    /**
     * Find injection target in Gemini UI
     */
    getButtonInjectionTarget(): HTMLElement | null {
        const selectors = [
            'header [aria-haspopup="menu"]', // Model switcher
            'header .flex-1.overflow-hidden', // Center area
            'header nav',
            '.chat-app-header',
            'header', // Fallback: Generic header
            '[role="banner"]', // Fallback: ARIA banner role
            'body', // Final Fallback: Fixed position overlay
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
