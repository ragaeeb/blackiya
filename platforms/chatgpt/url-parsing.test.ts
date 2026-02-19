/**
 * ChatGPT URL parsing tests
 *
 * Covers extractConversationId (page URL), extractConversationIdFromUrl
 * (API endpoint), buildApiUrl, and buildApiUrls.
 */

import { beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('@/utils/logger', () => ({
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, setLevel: () => {} },
}));

describe('ChatGPT URL parsing', () => {
    let adapter: any;

    beforeAll(async () => {
        const module = await import('@/platforms/chatgpt');
        adapter = module.createChatGPTAdapter();
    });

    describe('extractConversationId (page URL)', () => {
        it('should extract id from standard /c/{uuid} URL', () => {
            expect(adapter.extractConversationId('https://chatgpt.com/c/696bc3d5-fa84-8328-b209-4d65cb229e59')).toBe(
                '696bc3d5-fa84-8328-b209-4d65cb229e59',
            );
        });

        it('should extract id from gizmo /g/{id}/c/{uuid} URL', () => {
            expect(
                adapter.extractConversationId('https://chatgpt.com/g/g-abc123/c/696bc3d5-fa84-8328-b209-4d65cb229e59'),
            ).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
        });

        it('should extract id from URL with query parameters', () => {
            expect(
                adapter.extractConversationId('https://chatgpt.com/c/696bc3d5-fa84-8328-b209-4d65cb229e59?model=gpt-4'),
            ).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
        });

        it('should support legacy chat.openai.com domain', () => {
            expect(
                adapter.extractConversationId('https://chat.openai.com/c/696bc3d5-fa84-8328-b209-4d65cb229e59'),
            ).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
        });

        it('should return null for homepage URL', () => {
            expect(adapter.extractConversationId('https://chatgpt.com/')).toBeNull();
        });

        it('should return null for non-ChatGPT domain', () => {
            expect(adapter.extractConversationId('https://google.com/c/123')).toBeNull();
        });

        it('should return null for invalid UUID format', () => {
            expect(adapter.extractConversationId('https://chatgpt.com/c/invalid-id')).toBeNull();
        });

        it('should return null for completely invalid URL input', () => {
            expect(adapter.extractConversationId('not-a-valid-url')).toBeNull();
        });
    });

    describe('extractConversationId regex fallback (no URL constructor)', () => {
        it('should parse via regex when URL constructor is unavailable', () => {
            const previousURL = (globalThis as any).URL;
            try {
                (globalThis as any).URL = undefined;
                expect(
                    adapter.extractConversationId('https://chatgpt.com/c/696bc3d5-fa84-8328-b209-4d65cb229e59'),
                ).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
                expect(adapter.extractConversationId('https://chatgpt.com/c/invalid-id')).toBeNull();
            } finally {
                (globalThis as any).URL = previousURL;
            }
        });

        it('should return null when regex fallback finds no hostname/path match', () => {
            const previousURL = (globalThis as any).URL;
            try {
                (globalThis as any).URL = undefined;
                expect(adapter.extractConversationId('not a url')).toBeNull();
            } finally {
                (globalThis as any).URL = previousURL;
            }
        });
    });

    describe('extractConversationIdFromUrl (API endpoint)', () => {
        it('should extract id from stream_status endpoint', () => {
            expect(
                adapter.extractConversationIdFromUrl(
                    'https://chatgpt.com/backend-api/conversation/696bc3d5-fa84-8328-b209-4d65cb229e59/stream_status',
                ),
            ).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
        });

        it('should return null for invalid UUID in stream_status URL', () => {
            expect(
                adapter.extractConversationIdFromUrl(
                    'https://chatgpt.com/backend-api/conversation/not-a-uuid/stream_status',
                ),
            ).toBeNull();
        });

        it('should return null for non-stream_status endpoint', () => {
            expect(
                adapter.extractConversationIdFromUrl(
                    'https://chatgpt.com/backend-api/conversation/696bc3d5-fa84-8328-b209-4d65cb229e59/textdocs',
                ),
            ).toBeNull();
        });
    });

    describe('buildApiUrl / buildApiUrls', () => {
        const id = '696bc3d5-fa84-8328-b209-4d65cb229e59';

        it('should build chatgpt.com API URL', () => {
            expect(adapter.buildApiUrl(id)).toBe(`https://chatgpt.com/backend-api/conversation/${id}`);
        });

        it('should include both chatgpt.com and chat.openai.com candidates', () => {
            const urls = adapter.buildApiUrls(id);
            expect(urls).toContain(`https://chatgpt.com/backend-api/conversation/${id}`);
            expect(urls).toContain(`https://chat.openai.com/backend-api/conversation/${id}`);
        });

        it('should not include f/conversation path in buildApiUrls', () => {
            const urls = adapter.buildApiUrls(id);
            expect(urls).not.toContain(`https://chatgpt.com/backend-api/f/conversation/${id}`);
        });
    });
});
