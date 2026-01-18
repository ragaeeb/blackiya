/**
 * ChatGPT Platform Adapter
 *
 * Implements the LLMPlatform interface for ChatGPT.
 * Handles conversation ID extraction, API URL building, and filename formatting.
 *
 * @module platforms/chatgpt
 */

import { generateTimestamp, sanitizeFilename } from '../utils/download';
import type { ConversationData } from '../utils/types';
import type { LLMPlatform } from './types';

/**
 * Maximum length for the title portion of a filename
 */
const MAX_TITLE_LENGTH = 80;

/**
 * Regex pattern to match a valid ChatGPT conversation UUID
 * Format: 8-4-4-4-12 hex characters
 */
const CONVERSATION_ID_PATTERN = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/;

/**
 * ChatGPT Platform Adapter
 *
 * Supports both chatgpt.com and legacy chat.openai.com domains.
 * Handles standard /c/{id} format and gizmo /g/{gizmo}/c/{id} format.
 */
export const chatGPTAdapter: LLMPlatform = {
    name: 'ChatGPT',

    urlMatchPattern: 'https://chatgpt.com/*',

    apiEndpointPattern: /backend-api\/conversation\/[a-f0-9-]+$/,

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
        // Must be a ChatGPT or legacy OpenAI domain
        if (!url.includes('chatgpt.com') && !url.includes('chat.openai.com')) {
            return null;
        }

        // Look for /c/{uuid} pattern in the URL path
        const pathMatch = url.match(/\/c\/([a-f0-9-]+)/);
        if (!pathMatch) {
            return null;
        }

        const potentialId = pathMatch[1].split('?')[0]; // Remove query params

        // Validate it's a proper UUID format
        if (!CONVERSATION_ID_PATTERN.test(potentialId)) {
            return null;
        }

        return potentialId;
    },

    /**
     * Build the API URL for fetching conversation data
     *
     * @param conversationId - The conversation UUID
     * @returns The full API endpoint URL
     */
    buildApiUrl(conversationId: string): string {
        return `https://chatgpt.com/backend-api/conversation/${conversationId}`;
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
};
