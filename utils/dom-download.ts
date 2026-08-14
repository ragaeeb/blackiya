/**
 * DOM Download Utilities
 *
 * Encapsulates browser-specific DOM interactions for triggering file downloads.
 * Extracted so that callers can be unit-tested without needing real or polyfilled
 * browser APIs (Blob, URL.createObjectURL, document.createElement, etc.).
 *
 * @module utils/dom-download
 */

const downloadStringAsFile = (content: string, filename: string, contentType: string) => {
    const blob = new Blob([content], { type: contentType });
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

export const downloadStringAsJsonFile = (jsonString: string, filename: string) => {
    downloadStringAsFile(jsonString, filename, 'application/json');
};

export const downloadStringAsMarkdownFile = (markdown: string, filename: string) => {
    downloadStringAsFile(markdown, filename, 'text/markdown;charset=utf-8');
};
