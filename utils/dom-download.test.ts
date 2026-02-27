import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { downloadStringAsJsonFile } from './dom-download';

// Ensure happy-dom globals are available (test-setup.ts registers at preload,
// but some isolated runs may not have it registered yet)
if (typeof document === 'undefined') {
    GlobalRegistrator.register();
}

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

const isAnchorElement = (node: Node): node is HTMLAnchorElement => {
    const anchorCtor = globalThis.HTMLAnchorElement;
    if (typeof anchorCtor !== 'undefined' && node instanceof anchorCtor) {
        return true;
    }
    const maybeElement = node as { nodeName?: unknown; tagName?: unknown };
    const name =
        typeof maybeElement.nodeName === 'string'
            ? maybeElement.nodeName
            : typeof maybeElement.tagName === 'string'
              ? maybeElement.tagName
              : '';
    return name.toUpperCase() === 'A';
};

describe('downloadStringAsJsonFile', () => {
    let createdObjectUrls: string[] = [];
    let revokedObjectUrls: string[] = [];
    let appendedLinks: HTMLAnchorElement[] = [];
    let clickedLinks: HTMLAnchorElement[] = [];

    beforeEach(() => {
        createdObjectUrls = [];
        revokedObjectUrls = [];
        appendedLinks = [];
        clickedLinks = [];

        // Stub URL.createObjectURL and URL.revokeObjectURL
        URL.createObjectURL = mock((blob: Blob) => {
            const url = `blob:mock/${blob.size}`;
            createdObjectUrls.push(url);
            return url;
        }) as typeof URL.createObjectURL;

        URL.revokeObjectURL = mock((url: string) => {
            revokedObjectUrls.push(url);
        }) as typeof URL.revokeObjectURL;
    });

    afterEach(() => {
        // Clean up any links that may have been appended by failed tests
        for (const link of appendedLinks) {
            link.remove();
        }
        URL.createObjectURL = originalCreateObjectURL;
        URL.revokeObjectURL = originalRevokeObjectURL;
    });

    it('should create a Blob URL, click the anchor, and revoke the URL', () => {
        const originalAppendChild = document.body.appendChild.bind(document.body);

        document.body.appendChild = mock((node: Node) => {
            if (isAnchorElement(node)) {
                appendedLinks.push(node);
                // Capture clicks instead of triggering real navigation
                node.click = mock(() => {
                    clickedLinks.push(node);
                }) as () => void;
            }
            return originalAppendChild(node);
        }) as typeof document.body.appendChild;

        try {
            downloadStringAsJsonFile('{"key":"value"}', 'test.json');

            expect(createdObjectUrls.length).toBe(1);
            expect(revokedObjectUrls.length).toBe(1);
            expect(revokedObjectUrls[0]).toBe(createdObjectUrls[0]);
            expect(clickedLinks.length).toBe(1);
            expect(clickedLinks[0].download).toBe('test.json');
            expect(clickedLinks[0].href).toContain('blob:mock/');
        } finally {
            document.body.appendChild = originalAppendChild;
        }
    });

    it('should always revoke the object URL even if an error occurs during anchor setup', () => {
        const originalCreateElement = document.createElement.bind(document);
        // Make createElement throw after the anchor is created
        document.createElement = mock((tagName: string) => {
            const el = originalCreateElement(tagName);
            if (tagName === 'a') {
                Object.defineProperty(el, 'href', {
                    set() {
                        throw new Error('simulated DOM error');
                    },
                    configurable: true,
                });
            }
            return el;
        }) as typeof document.createElement;

        try {
            expect(() => downloadStringAsJsonFile('{}', 'test.json')).toThrow('simulated DOM error');
            // URL must be revoked even though the try block threw
            expect(revokedObjectUrls.length).toBe(1);
        } finally {
            document.createElement = originalCreateElement;
        }
    });

    it('should remove the anchor from the DOM after download', () => {
        const originalAppendChild = document.body.appendChild.bind(document.body);
        const captured: HTMLAnchorElement[] = [];

        document.body.appendChild = mock((node: Node) => {
            if (isAnchorElement(node)) {
                captured.push(node);
                node.click = mock(() => {}) as () => void;
            }
            return originalAppendChild(node);
        }) as typeof document.body.appendChild;

        try {
            downloadStringAsJsonFile('{}', 'out.json');
            // After the call completes the link must no longer be in the document body
            expect(captured.length).toBe(1);
            expect(document.body.contains(captured[0])).toBeFalse();
        } finally {
            document.body.appendChild = originalAppendChild;
        }
    });

    it('should set the correct download filename and content type on the created blob', () => {
        const blobs: Blob[] = [];
        URL.createObjectURL = mock((blob: Blob) => {
            blobs.push(blob);
            return 'blob:mock/captured';
        }) as typeof URL.createObjectURL;

        const originalAppendChild = document.body.appendChild.bind(document.body);
        document.body.appendChild = mock((node: Node) => {
            if (isAnchorElement(node)) {
                node.click = mock(() => {}) as () => void;
            }
            return originalAppendChild(node);
        }) as typeof document.body.appendChild;

        try {
            downloadStringAsJsonFile('{"a":1}', 'export.json');
            expect(blobs.length).toBe(1);
            expect(blobs[0].type.toLowerCase()).toStartWith('application/json');
            expect(blobs[0].size).toBeGreaterThan(0);
        } finally {
            document.body.appendChild = originalAppendChild;
        }
    });
});
