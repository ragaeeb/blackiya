/**
 * Platform adapter interface for LLM providers
 *
 * This interface allows the extension to be extensible to multiple LLM platforms
 * (ChatGPT, Gemini, Grok, etc.) by implementing a common contract.
 *
 * @module platforms/types
 */

import type { ConversationData } from '../utils/types';

export interface PlatformReadiness {
    ready: boolean;
    terminal: boolean;
    reason: string;
    contentHash: string | null;
    latestAssistantTextLength: number;
}

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
     * Find the DOM element where the save button should be injected
     */
    getButtonInjectionTarget(): HTMLElement | null;

    /**
     * Optional helper to check if a payload contains conversation data
     * Useful for platforms with complex/nested responses (like Gemini)
     */
    isConversationPayload?: (payload: any) => boolean;

    /**
     * Optional regex pattern matching completion-signal endpoints.
     * When a fetch to a matching URL is intercepted, the interceptor will
     * extract the conversation ID from the URL via `extractConversationIdFromUrl`
     * and proactively fetch the full conversation JSON via `buildApiUrl`.
     *
     * Example: ChatGPT calls `backend-api/conversation/{id}/stream_status`
     * after streaming completes — the ID is right in the URL.
     */
    completionTriggerPattern?: RegExp;

    /**
     * Build the API URL to fetch the full conversation data.
     * Required when `completionTriggerPattern` is set.
     *
     * @param conversationId - The conversation ID extracted from the trigger URL
     * @returns The full API URL to GET the conversation JSON
     */
    buildApiUrl?: (conversationId: string) => string;

    /**
     * Build multiple API URL candidates for fetching full conversation data.
     * Useful for platform endpoint drift where different deployments may expose
     * different paths for the same conversation resource.
     *
     * @param conversationId - The conversation ID extracted from a trigger or URL
     * @returns Ordered candidate URLs (highest confidence first)
     */
    buildApiUrls?: (conversationId: string) => string[];

    /**
     * Extract a conversation ID from a completion-trigger URL.
     * Used after a `completionTriggerPattern` match to find the conversation ID
     * so we can fetch the full conversation data.
     *
     * @param url - The URL that matched `completionTriggerPattern`
     * @returns The conversation ID or null if not found
     */
    extractConversationIdFromUrl?: (url: string) => string | null;

    /**
     * Optional generation ID extractor. Used by Signal Fusion Engine (SFE) to
     * correlate platform-native generation IDs where available.
     */
    extractGenerationId?: (url: string, payload?: unknown) => string | null;

    /**
     * Optional platform-specific readiness evaluator used by SFE.
     * If omitted, the runner falls back to generic readiness checks.
     */
    evaluateReadiness?: (data: ConversationData) => PlatformReadiness;

    /**
     * Optional DOM-based signal for whether the platform is actively generating.
     * Used by runner guardrails for save/readiness transitions.
     */
    isPlatformGenerating?: () => boolean;

    /**
     * Optional DOM-based title extraction fallback.
     * Called at save/copy time when the cached title appears to be a
     * platform default (e.g., "New conversation") because the real title
     * was generated asynchronously and never intercepted via API.
     *
     * @returns The conversation title extracted from the page DOM, or null.
     */
    extractTitleFromDom?: () => string | null;

    /**
     * Optional list of known default/placeholder titles for this platform.
     * Used to decide whether `extractTitleFromDom` should be attempted.
     */
    defaultTitles?: string[];
}
