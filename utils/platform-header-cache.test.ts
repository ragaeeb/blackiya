import { beforeEach, describe, expect, it, mock } from 'bun:test';

const storageState = new Map<string, unknown>();

mock.module('wxt/browser', () => ({
    browser: {
        storage: {
            local: {
                get: async (key: string) => ({ [key]: storageState.get(key) }),
                set: async (payload: Record<string, unknown>) => {
                    for (const [k, v] of Object.entries(payload)) {
                        storageState.set(k, v);
                    }
                },
            },
        },
    },
}));

describe('platform-header-cache', () => {
    beforeEach(() => {
        storageState.clear();
    });

    it('should persist and read headers by platform', async () => {
        const { readPlatformHeadersFromCache, writePlatformHeadersToCache } = await import(
            '@/utils/platform-header-cache'
        );

        await writePlatformHeadersToCache('ChatGPT', {
            authorization: 'Bearer test-token',
            'oai-client-version': 'prod-1',
        });

        const cached = await readPlatformHeadersFromCache('ChatGPT');
        expect(cached?.authorization).toBe('Bearer test-token');
        expect(cached?.['oai-client-version']).toBe('prod-1');
    });

    it('should clear cached headers for a platform', async () => {
        const { clearPlatformHeadersCache, readPlatformHeadersFromCache, writePlatformHeadersToCache } = await import(
            '@/utils/platform-header-cache'
        );

        await writePlatformHeadersToCache('ChatGPT', {
            authorization: 'Bearer test-token',
        });
        await clearPlatformHeadersCache('ChatGPT');
        const cached = await readPlatformHeadersFromCache('ChatGPT');
        expect(cached).toBeUndefined();
    });
});
