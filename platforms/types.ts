/**
 * Platform adapter interface for LLM providers
 *
 * This interface allows the extension to be extensible to multiple LLM platforms
 * (ChatGPT, Gemini, Grok, etc.) by implementing a common contract.
 *
 * @module platforms/types
 */

import type { ConversationData } from '../utils/types';

/**
 * Interface that all LLM platform adapters must implement
 */
export interface LLMPlatform {
    /** Display name of the platform (e.g., "ChatGPT", "Gemini") */
    name: string;

    /** URL match pattern for the content script (e.g., "https://chatgpt.com/*") */
    urlMatchPattern: string;

    /** Regex pattern to match the conversation API endpoint */
    apiEndpointPattern: RegExp;

    /**
     * Extract the conversation ID from the current page URL
     * @param url - The current page URL
     * @returns The conversation ID or null if not found
     */
    extractConversationId(url: string): string | null;

    /**
     * Build the API URL to fetch conversation data
     * @param conversationId - The conversation ID
     * @returns The full API URL
     */
    buildApiUrl(conversationId: string): string;

    /**
     * Format the filename for the downloaded JSON file
     * @param data - The conversation data
     * @returns A sanitized filename (without extension)
     */
    formatFilename(data: ConversationData): string;
}
