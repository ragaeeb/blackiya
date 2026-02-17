/**
 * Download Utilities
 *
 * Helper functions for downloading JSON files and filename handling
 *
 * @module utils/download
 */

import { logger } from '@/utils/logger';

/**
 * Sanitize a string for use as a filename
 *
 * Removes or replaces characters that are invalid in file systems:
 * - Replaces spaces with underscores
 * - Removes: / \ : * ? " < > |
 * - Collapses multiple underscores
 * - Trims whitespace
 *
 * @param filename - The raw filename string
 * @returns A sanitized filename safe for use on all major file systems
 */
export function sanitizeFilename(filename: string): string {
    if (!filename || filename.trim().length === 0) {
        return 'untitled';
    }

    const sanitized = filename
        .trim()
        // Replace spaces with underscores
        .replace(/\s+/g, '_')
        // Remove invalid filesystem characters: / \ : * ? " < > |
        .replace(/[/\\:*?"<>|]/g, '')
        // Collapse multiple underscores
        .replace(/_+/g, '_')
        // Remove leading/trailing underscores
        .replace(/^_+|_+$/g, '');

    // If after sanitization we have an empty string, return 'untitled'
    if (sanitized.length === 0) {
        return 'untitled';
    }

    return sanitized;
}

/**
 * Generate a timestamp string for filenames
 *
 * @param unixTime - Optional Unix timestamp (seconds since epoch). If not provided, uses current time.
 * @returns A timestamp string in format: YYYY-MM-DD_HH-MM-SS
 */
export function generateTimestamp(unixTime?: number): string {
    const date = typeof unixTime === 'number' ? new Date(unixTime * 1000) : new Date();

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

/**
 * Download data as a JSON file using blob URL
 *
 * @param data - The data to download as JSON
 * @param filename - The filename (without .json extension)
 */
export function downloadAsJSON(data: unknown, filename: string): void {
    let url: string | null = null;
    let link: HTMLAnchorElement | null = null;

    try {
        if (typeof document === 'undefined' || typeof URL === 'undefined') {
            logger.error('Download failed: browser APIs are unavailable');
            return;
        }

        const jsonString = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        url = URL.createObjectURL(blob);

        link = document.createElement('a');
        link.href = url;
        link.download = `${filename}.json`;
        document.body.appendChild(link);
        link.click();
    } catch (error) {
        logger.error('Download failed:', error);
    } finally {
        if (link?.parentNode) {
            link.parentNode.removeChild(link);
        }
        if (url) {
            URL.revokeObjectURL(url);
        }
    }
}
