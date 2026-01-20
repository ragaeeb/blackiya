/**
 * Platform Adapter Factory
 *
 * Manages the registration and selection of platform-specific adapters.
 */

import { chatGPTAdapter } from '@/platforms/chatgpt';
import { geminiAdapter } from '@/platforms/gemini';
import { grokAdapter } from '@/platforms/grok';
import type { LLMPlatform } from '@/platforms/types';

/**
 * Get all supported platforms.
 * Encapsulated in a function to allow future extension (e.g., dynamic registration).
 */
function getPlatforms(): LLMPlatform[] {
    return [chatGPTAdapter, geminiAdapter, grokAdapter];
}

/**
 * Get the appropriate platform adapter for a given URL
 *
 * @param url - The URL to check (either page URL or API URL)
 * @returns The matching platform adapter or null if not found
 */
export function getPlatformAdapter(url: string): LLMPlatform | null {
    return getPlatforms().find((p) => p.isPlatformUrl(url)) || null;
}

/**
 * Get the platform adapter that matches an API endpoint URL
 *
 * @param url - The intercepted API endpoint URL
 * @returns The matching platform adapter or null if not found
 */
export function getPlatformAdapterByApiUrl(url: string): LLMPlatform | null {
    return getPlatforms().find((p) => p.apiEndpointPattern.test(url)) || null;
}
