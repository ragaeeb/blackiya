/**
 * ChatGPT platform primitive utilities and shared constants.
 *
 * These are low-level building blocks used across the chatgpt platform modules.
 * No adapter or platform-interface concerns here.
 *
 * @module platforms/chatgpt/utils
 */

/** Matches a valid ChatGPT conversation UUID (8-4-4-4-12 hex, case-insensitive). */
export const CONVERSATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export const HOST_CANDIDATES = ['https://chatgpt.com', 'https://chat.openai.com'];

export const PLACEHOLDER_TITLE_PATTERNS = [/^new chat$/i, /^new conversation$/i, /^untitled$/i];

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Primitive normalizers
// ---------------------------------------------------------------------------

/** Trims and returns a non-empty string, or null. */
export const normalizeText = (value: unknown): string | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

/** Returns a finite number or null. */
export const normalizeNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Returns model slug string unless it's null/empty/"auto". */
export const normalizeModelSlug = (value: unknown): string | null => {
    const normalized = normalizeText(value);
    if (!normalized || normalized.toLowerCase() === 'auto') {
        return null;
    }
    return normalized;
};

/** Safe JSON.parse — returns null on failure instead of throwing. */
export const tryParseJson = (text: string): unknown | null => {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

/** Returns true when the title is empty or matches a known generic placeholder. */
export const isPlaceholderTitle = (title: string): boolean => {
    const normalized = title.trim();
    if (normalized.length === 0) {
        return true;
    }
    return PLACEHOLDER_TITLE_PATTERNS.some((pattern) => pattern.test(normalized));
};
