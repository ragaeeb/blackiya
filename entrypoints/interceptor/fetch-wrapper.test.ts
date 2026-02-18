import { describe, expect, it } from 'bun:test';
import { createFetchInterceptor } from '@/entrypoints/interceptor/fetch-wrapper';

describe('fetch-wrapper', () => {
    it('falls back to original fetch when interceptor throws', async () => {
        const response = new Response('ok', { status: 200 });
        const originalFetch = ((..._args: Parameters<typeof fetch>) =>
            Promise.resolve(response)) as unknown as typeof fetch;
        const wrapped = createFetchInterceptor(originalFetch, () => {
            throw new Error('boom');
        });

        const result = await wrapped('https://example.com');
        expect(result.status).toBe(200);
    });
});
