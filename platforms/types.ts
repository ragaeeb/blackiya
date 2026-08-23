/**
 * Platform adapter interface for LLM providers
 *
 * This interface allows the extension to be extensible to multiple LLM platforms
 * (ChatGPT, Gemini, Grok, etc.) by implementing a common contract.
 *
 * @module platforms/types
 */

import type { ConversationData } from '../utils/types';

export type PlatformReadiness = {
    ready: boolean;
    terminal: boolean;
    reason: string;
    contentHash: string | null;
    latestAssistantTextLength: number;
};

/**
 * Interface that all LLM platform adapters must implement
 */
export type LLMPlatform = {
    /** Display name of the platform (e.g., "ChatGPT", "Gemini") */
    name: string;

    /** URL match pattern for the content script (e.g., "https://chatgpt.com/*") */
    urlMatchPattern: string;

    /**
     * Check if a URL belongs to this platform
     */
    isPlatformUrl(url: string): boolean;

    /**
     * Extract the conversation ID from the current page URL
     * @param url - The current page URL
     * @returns The conversation ID or null if not found
     */
    extractConversationId(url: string): string | null;

    /**
     * Parse raw intercepted data into standardized ConversationData
     * @param data - The raw response data (as string)
     * @param url - The URL of the intercepted request
     * @returns Standardized conversation data or null if parsing fails
     */
    parseInterceptedData(data: string, url: string): ConversationData | null;

    /**
     * Format the filename for the downloaded JSON file
     * @param data - The conversation data
     * @returns A sanitized filename (without extension)
     */
    formatFilename(data: ConversationData): string;

    /**
     * Optional helper to check if a payload contains conversation data
     * Useful for platforms with complex/nested responses (like Gemini)
     */
    isConversationPayload?: (payload: unknown) => boolean;

    /** Fast allowlist used before cloning and parsing observed responses. */
    isConversationDetailRequest?: (url: string, method: string, headers?: HeadersInit) => boolean;

    /** Exact HTTPS origins allowed for adapter-built direct detail requests. */
    detailRequestOrigins?: readonly string[];

    buildApiUrl?: (conversationId: string) => string;
    buildApiUrls?: (conversationId: string) => string[];

    evaluateReadiness?: (data: ConversationData) => PlatformReadiness;
};
