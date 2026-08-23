/**
 * Platform Adapter Factory
 *
 * Manages the registration and selection of platform-specific adapters.
 */

import { chatGPTAdapter } from '@/platforms/chatgpt';
import { claudeAdapter } from '@/platforms/claude';
import { deepSeekAdapter } from '@/platforms/deepseek';
import { geminiAdapter } from '@/platforms/gemini';
import { grokAdapter } from '@/platforms/grok';
import { metaAdapter } from '@/platforms/meta';
import { novaAdapter } from '@/platforms/nova';
import { qwenAdapter } from '@/platforms/qwen';
import type { LLMPlatform } from '@/platforms/types';
import { zaiAdapter } from '@/platforms/zai';

/**
 * Get all supported platforms.
 * Encapsulated in a function to allow future extension (e.g., dynamic registration).
 */
const getPlatforms = () => {
    return [
        chatGPTAdapter,
        geminiAdapter,
        grokAdapter,
        claudeAdapter,
        deepSeekAdapter,
        qwenAdapter,
        zaiAdapter,
        metaAdapter,
        novaAdapter,
    ];
};

/**
 * Get the appropriate platform adapter for a given URL
 *
 * @param url - The URL to check (either page URL or API URL)
 * @returns The matching platform adapter or null if not found
 */
export const getPlatformAdapter = (url: string): LLMPlatform | null => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'https:') {
        return null;
    }
    return getPlatforms().find((platform) => platform.isPlatformUrl(parsed.href)) ?? null;
};
