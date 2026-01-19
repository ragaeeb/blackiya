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

    // Match batchexecute endpoint AND the specific RPC ID for conversation data
    apiEndpointPattern: /BardChatUi\/data\/batchexecute.*rpcids=.*hNvQHb/,

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
        const appMatch = url.match(/\/app\/([a-z0-9-]+)/);
        if (appMatch) {
            return appMatch[1];
        }

        // Try share URL
        const shareMatch = url.match(/\/share\/([a-z0-9-]+)/);
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
    /**
     * Parse the custom Google "batchexecute" response format
     */
    parseInterceptedData(data: string, _url: string): ConversationData | null {
        try {
            // 1. Strip the security prefix if present
            const MAGIC_HEADER = ")]}'";
            let cleanedData = data.trim();
            if (cleanedData.startsWith(MAGIC_HEADER)) {
                cleanedData = cleanedData.substring(MAGIC_HEADER.length).trim();
            }

            // 2. Find the JSON array part
            // The format is often: [length]\n[array]
            const startBracket = cleanedData.indexOf('[');
            const endBracket = cleanedData.lastIndexOf(']');

            if (startBracket === -1 || endBracket === -1) {
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
            // [[[[conversationId, responseId, [messages...]]]]]
            // Access: payload[0][0][0]
            const conversationData = payload[0]?.[0]?.[0];

            if (!conversationData || !Array.isArray(conversationData)) {
                return null;
            }

            let conversationId = conversationData[0]; // e.g. "c_123..."

            // Normalize ID: remove 'c_' prefix to match URL ID
            if (conversationId && typeof conversationId === 'string' && conversationId.startsWith('c_')) {
                conversationId = conversationId.slice(2);
            }

            // const responseId = conversationData[1];
            const messages = conversationData[2] || [];

            // Reconstruct mapping from message list
            const mapping: Record<string, MessageNode> = {};

            if (Array.isArray(messages)) {
                messages.forEach((segment: any, index: number) => {
                    const id = `segment-${index}`;

                    // Try to extract text content reliably
                    let textContent = '';
                    if (Array.isArray(segment)) {
                        // Sometimes content is deeply nested or just the first string
                        // For now, we stringify if it's complex, or take the string if simple
                        textContent = typeof segment[0] === 'string' ? segment[0] : JSON.stringify(segment); // Fallback
                    } else {
                        textContent = String(segment);
                    }

                    mapping[id] = {
                        id,
                        message: {
                            id,
                            author: {
                                role: 'assistant',
                                name: 'Gemini',
                            },
                            content: {
                                content_type: 'text',
                                parts: [textContent],
                            },
                            create_time: Date.now() / 1000,
                            update_time: Date.now() / 1000,
                        },
                        parent: index > 0 ? `segment-${index - 1}` : null,
                        children: index < messages.length - 1 ? [`segment-${index + 1}`] : [],
                    };
                });
            }

            return {
                title: 'Gemini Conversation',
                create_time: Date.now() / 1000,
                update_time: Date.now() / 1000,
                conversation_id: conversationId || 'unknown',
                mapping,
                current_node: `segment-${Math.max(0, messages.length - 1)}`,
                is_archived: false,
                safe_urls: [],
                blocked_urls: [],
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
