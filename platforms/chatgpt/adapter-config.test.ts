/**
 * ChatGPT adapter configuration tests
 *
 * Covers: apiEndpointPattern, completionTriggerPattern,
 * getButtonInjectionTarget, isPlatformGenerating,
 * and guards against removed DOM-title-fallback fields.
 */

import { beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('@/utils/logger', () => ({
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, setLevel: () => {} },
}));

const ID = '696bc3d5-fa84-8328-b209-4d65cb229e59';

describe('ChatGPT adapter configuration', () => {
    let adapter: any;

    beforeAll(async () => {
        const module = await import('@/platforms/chatgpt');
        adapter = module.createChatGPTAdapter();
    });

    describe('apiEndpointPattern', () => {
        it('should match backend-api/conversation/{uuid}', () => {
            expect(adapter.apiEndpointPattern.test(`https://chatgpt.com/backend-api/conversation/${ID}`)).toBeTrue();
        });

        it('should match backend-api/conversation/{uuid} with query params', () => {
            expect(
                adapter.apiEndpointPattern.test(`https://chatgpt.com/backend-api/conversation/${ID}?foo=bar`),
            ).toBeTrue();
        });

        it('should match backend-api/f/conversation', () => {
            expect(adapter.apiEndpointPattern.test('https://chatgpt.com/backend-api/f/conversation')).toBeTrue();
        });

        it('should not match unrelated API paths', () => {
            expect(adapter.apiEndpointPattern.test('https://chatgpt.com/backend-api/models')).toBeFalse();
        });
    });

    describe('completionTriggerPattern', () => {
        it('should match stream_status endpoint', () => {
            expect(
                adapter.completionTriggerPattern.test(
                    `https://chatgpt.com/backend-api/conversation/${ID}/stream_status`,
                ),
            ).toBeTrue();
        });

        it('should not match textdocs endpoint', () => {
            expect(
                adapter.completionTriggerPattern.test(`https://chatgpt.com/backend-api/conversation/${ID}/textdocs`),
            ).toBeFalse();
        });
    });

    describe('no DOM title fallback (V2.1-036 guard)', () => {
        it('should NOT expose extractTitleFromDom (ChatGPT uses SSE title resolution)', () => {
            expect(adapter.extractTitleFromDom).toBeUndefined();
        });

        it('should NOT expose defaultTitles (ChatGPT uses SSE title resolution)', () => {
            expect(adapter.defaultTitles).toBeUndefined();
        });
    });

    describe('getButtonInjectionTarget', () => {
        it('should return parent element when selector matches', () => {
            const parent = { id: 'parent' };
            const originalDocument = (globalThis as any).document;
            (globalThis as any).document = {
                querySelector: (sel: string) =>
                    sel === '[data-testid="model-switcher-dropdown-button"]' ? { parentElement: parent } : null,
            };
            try {
                expect(adapter.getButtonInjectionTarget()).toBe(parent);
            } finally {
                (globalThis as any).document = originalDocument;
            }
        });

        it('should return null when no selector matches', () => {
            const originalDocument = (globalThis as any).document;
            (globalThis as any).document = { querySelector: () => null };
            try {
                expect(adapter.getButtonInjectionTarget()).toBeNull();
            } finally {
                (globalThis as any).document = originalDocument;
            }
        });
    });
});
