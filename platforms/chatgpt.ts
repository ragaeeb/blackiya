/**
 * ChatGPT Platform Adapter
 *
 * Implements the LLMPlatform interface for ChatGPT.
 * Handles conversation ID extraction, API URL building, and filename formatting.
 *
 * @module platforms/chatgpt
 */

import type { LLMPlatform } from '@/platforms/types';
import { generateTimestamp, sanitizeFilename } from '@/utils/download';
import { logger } from '@/utils/logger';
import type { ConversationData } from '@/utils/types';

/**
 * Maximum length for the title portion of a filename
 */
const MAX_TITLE_LENGTH = 80;

/**
 * Regex pattern to match a valid ChatGPT conversation UUID
 * Format: 8-4-4-4-12 hex characters
 * Anchored and case-insensitive
 */
const CONVERSATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * Create a ChatGPT Platform Adapter instance.
 *
 * Supports both chatgpt.com and legacy chat.openai.com domains.
 * Handles standard /c/{id} format and gizmo /g/{gizmo}/c/{id} format.
 */
export function createChatGPTAdapter(): LLMPlatform {
    return {
    name: 'ChatGPT',

    urlMatchPattern: 'https://chatgpt.com/*',

    apiEndpointPattern: /backend-api\/conversation\/[a-f0-9-]+$/,

    /**
     * Check if a URL belongs to ChatGPT
     */
    isPlatformUrl(url: string): boolean {
        return url.includes('chatgpt.com') || url.includes('chat.openai.com');
    },

    /**
     * Extract conversation ID from ChatGPT URL
     *
     * Supports:
     * - https://chatgpt.com/c/{uuid}
     * - https://chatgpt.com/g/{gizmo-id}/c/{uuid}
     * - https://chat.openai.com/c/{uuid} (legacy)
     * - URLs with query parameters
     *
     * @param url - The current page URL
     * @returns The conversation UUID or null if not found/invalid
     */
    extractConversationId(url: string): string | null {
        try {
            const urlObj = new URL(url);

            // Validate strict hostname
            if (urlObj.hostname !== 'chatgpt.com' && urlObj.hostname !== 'chat.openai.com') {
                return null;
            }

            // Look for /c/{uuid} pattern in the pathname
            const pathMatch = urlObj.pathname.match(/\/c\/([a-f0-9-]+)/i);
            if (!pathMatch) {
                return null;
            }

            const potentialId = pathMatch[1];

            // Validate it's a proper UUID format
            if (!CONVERSATION_ID_PATTERN.test(potentialId)) {
                return null;
            }

            return potentialId;
        } catch {
            // Invalid URL format
            return null;
        }
    },

    /**
     * Parse intercepted ChatGPT API response
     *
     * @param data - Raw text or parsed object
     * @param _url - The API endpoint URL
     * @returns Validated ConversationData or null
     */
    parseInterceptedData(data: string | any, _url: string): ConversationData | null {
        try {
            const parsed = typeof data === 'string' ? JSON.parse(data) : data;

            // Basic validation of ChatGPT structure
            if (parsed && typeof parsed.title === 'string' && parsed.mapping) {
                return parsed as ConversationData;
            }
        } catch (e) {
            logger.error('Failed to parse ChatGPT data:', e);
        }
        return null;
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
            title = `conversation_${data.conversation_id.slice(0, 8)}`;
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
     * Find injection target in ChatGPT UI
     */
    getButtonInjectionTarget(): HTMLElement | null {
        const selectors = [
            '[data-testid="model-switcher-dropdown-button"]',
            'header nav',
            '.flex.items-center.justify-between',
            'header .flex',
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
}

/**
 * ChatGPT Platform Adapter singleton instance.
 */
export const chatGPTAdapter: LLMPlatform = createChatGPTAdapter();
