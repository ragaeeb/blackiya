/**
 * Platform Constants
 *
 * Shared constants for all supported LLM platforms
 * Used across configuration, content scripts, and interceptors
 *
 * @module platforms/constants
 */

/**
 * Supported LLM Platform URLs
 * These patterns are used in:
 * - wxt.config.ts (host_permissions)
 * - entrypoints/main.content.ts (content script matches)
 * - entrypoints/interceptor.content.ts (interceptor matches)
 */
export const SUPPORTED_PLATFORM_URLS = [
    'https://chatgpt.com/*',
    'https://chat.openai.com/*',
    'https://gemini.google.com/*',
    'https://x.com/i/grok*',
    'https://x.com/i/api/*',
    'https://grok.com/*',
] as const;

/**
 * Type-safe platform URL type
 */
export type PlatformUrl = (typeof SUPPORTED_PLATFORM_URLS)[number];

/**
 * Google RPC Constants
 */
export const GOOGLE_SECURITY_PREFIX = ")]}'\n\n";

export const GEMINI_RPC_IDS = {
    TITLES: 'MaZiqc',
    CONVERSATION: 'hNvQHb',
} as const;
