/**
 * DOM Download Utilities
 *
 * Encapsulates browser-specific DOM interactions for triggering file downloads.
 * Extracted so that callers can be unit-tested without needing real or polyfilled
 * browser APIs (Blob, URL.createObjectURL, document.createElement, etc.).
 *
 * @module utils/dom-download
 */

/**
 * Create a Blob URL from a JSON string and trigger a file download via an
 * invisible anchor element.  Cleans up the anchor and revokes the object URL
 * in a `finally` block so resources are released even when an error occurs.
 *
 * @param jsonString - Pre-serialized JSON content
 * @param filename  - Full filename including extension (e.g. `"chat.json"`)
 */
export const downloadStringAsJsonFile = (jsonString: string, filename: string) => {
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    let link: HTMLAnchorElement | null = null;

    try {
        link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
    } finally {
        if (link?.parentNode) {
            link.parentNode.removeChild(link);
        }
        URL.revokeObjectURL(url);
    }
};
