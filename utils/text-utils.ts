import { GOOGLE_SECURITY_PREFIX } from '../platforms/constants';

/**
 * Text Utility Functions
 *
 * Common text manipulation helpers used across the application.
 */

/**
 * Removes the Google JSON security prefix (magic header) from a response string.
 * Handles both the exact constant match and loose regex matching with variable whitespace.
 *
 * @param text - The raw response text that may contain the security header
 * @returns The text with the security header removed, or the original text if not found
 *
 * @example
 * stripMagicHeader(")]}'\n\n[1,2,3]") // returns "[1,2,3]"
 */
export function stripMagicHeader(text: string): string {
    if (!text) {
        return '';
    }

    const cleanText = text.trimStart();

    if (cleanText.startsWith(GOOGLE_SECURITY_PREFIX)) {
        return cleanText.substring(GOOGLE_SECURITY_PREFIX.length).trimStart();
    }

    // Try regex for loose matching of the prefix
    const match = cleanText.match(/^\)\]\}'\s*/);
    if (match) {
        return cleanText.substring(match[0].length).trimStart();
    }

    return cleanText;
}

/**
 * Standardizes a JSON string by removing common garbage characters.
 * Currently just trims the string.
 *
 * @param text - The text to clean
 * @returns Cleaned text
 */
export function cleanJsonString(text: string): string {
    return text.trim();
}

/**
 * Removes duplicate string entries while keeping first-seen ordering.
 */
export function dedupePreserveOrder(values: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        if (seen.has(value)) {
            continue;
        }
        seen.add(value);
        out.push(value);
    }
    return out;
}

/**
 * Returns a copy of the list limited to its newest entries.
 */
export function keepMostRecentEntries<T>(values: T[], maxEntries: number): T[] {
    if (maxEntries <= 0) {
        return [];
    }
    if (values.length <= maxEntries) {
        return [...values];
    }
    return values.slice(values.length - maxEntries);
}
