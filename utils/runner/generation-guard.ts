/**
 * Utilities for detecting whether a platform is actively generating a response.
 * DOM-based checks are isolated here and kept behind the ChatGPT guard so
 * non-ChatGPT platforms never incur DOM query costs.
 */

import type { LLMPlatform } from '@/platforms/types';

const CHATGPT_STOP_BUTTON_SELECTORS = [
    '[data-testid="stop-button"]',
    'button[aria-label*="Stop generating"]',
    'button[aria-label*="Stop response"]',
    'button[aria-label="Stop"]',
] as const;

const safeQuerySelector = (selector: string): Element | null => {
    if (typeof document.querySelector !== 'function') {
        return null;
    }
    try {
        return document.querySelector(selector);
    } catch {
        return null;
    }
};

/**
 * Checks whether ChatGPT is actively generating by inspecting the DOM for
 * an enabled stop-button or a streaming sentinel attribute.
 */
export const detectChatGPTGenerating = (): boolean => {
    for (const selector of CHATGPT_STOP_BUTTON_SELECTORS) {
        const button = safeQuerySelector(selector) as HTMLButtonElement | null;
        if (button && !button.disabled) {
            return true;
        }
    }
    return !!safeQuerySelector('[data-is-streaming="true"], [data-testid*="streaming"]');
};

/**
 * Returns `true` when the given adapter reports an active generation.
 * Delegates to `adapter.isPlatformGenerating()` when available;
 * falls back to `detectChatGPTGenerating` for the ChatGPT adapter.
 */
export const detectPlatformGenerating = (adapter: LLMPlatform | null): boolean => {
    if (!adapter) {
        return false;
    }
    if (adapter.isPlatformGenerating) {
        return adapter.isPlatformGenerating();
    }
    if (adapter.name === 'ChatGPT') {
        return detectChatGPTGenerating();
    }
    return false;
};
