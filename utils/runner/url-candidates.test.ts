import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { LLMPlatform } from '@/platforms/types';
import { getFetchUrlCandidates, getRawSnapshotReplayUrls } from '@/utils/runner/url-candidates';

describe('url-candidates', () => {
    describe('getFetchUrlCandidates', () => {
        let originalWindow: any;

        beforeEach(() => {
            originalWindow = (globalThis as any).window;
            if (!(globalThis as any).window) {
                (globalThis as any).window = {};
            }
            if (!(globalThis as any).window.location) {
                (globalThis as any).window.location = {};
            }
        });

        afterEach(() => {
            (globalThis as any).window = originalWindow;
        });

        it('should compile unique ordered urls based on the adapter', () => {
            const originalOrigin = globalThis.window.location.origin;
            (globalThis.window as any).location.origin = 'https://chatgpt.com';

            const adapter: Partial<LLMPlatform> = {
                buildApiUrl: (cid: string) => `https://chatgpt.com/api/${cid}`,
                buildApiUrls: (cid: string) => [
                    `https://chatgpt.com/api/backup/${cid}`,
                    `https://chatgpt.com/api/${cid}`,
                ],
            };

            const urls = getFetchUrlCandidates(adapter as LLMPlatform, 'conv-1');

            expect(urls).toEqual(['https://chatgpt.com/api/backup/conv-1', 'https://chatgpt.com/api/conv-1']);

            (globalThis.window as any).location.origin = originalOrigin;
        });

        it('should filter out cross-origin urls', () => {
            const originalOrigin = (globalThis.window as any).location.origin;
            (globalThis.window as any).location.origin = 'https://chatgpt.com';

            const adapter: Partial<LLMPlatform> = {
                buildApiUrl: () => `https://chatgpt.com/api`,
                buildApiUrls: () => [`https://evil.com/api`],
            };

            const urls = getFetchUrlCandidates(adapter as LLMPlatform, 'conv-1');

            expect(urls).toEqual(['https://chatgpt.com/api']);
            (globalThis.window as any).location.origin = originalOrigin;
        });
    });

    describe('getRawSnapshotReplayUrls', () => {
        it('should return just the snapshot url if not Grok', () => {
            const adapter: Partial<LLMPlatform> = { name: 'ChatGPT' };
            const urls = getRawSnapshotReplayUrls(adapter as LLMPlatform, 'c-1', { url: 'http://test' });
            expect(urls).toEqual(['http://test']);
        });

        it('should return additional alternate urls for Grok', () => {
            const adapter: Partial<LLMPlatform> = { name: 'Grok' };
            const urls = getRawSnapshotReplayUrls(adapter as LLMPlatform, 'c-1', { url: 'http://test' });
            expect(urls.length).toBeGreaterThan(1);
            expect(urls[0]).toBe('http://test');
            expect(urls).toContain(
                'https://grok.com/rest/app-chat/conversations_v2/c-1?includeWorkspaces=true&includeTaskResult=true',
            );
        });
    });
});
