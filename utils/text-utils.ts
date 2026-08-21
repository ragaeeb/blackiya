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
export const stripMagicHeader = (text: string): string => {
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
};
