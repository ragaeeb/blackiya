import { describe, expect, it } from 'bun:test';
import { createFetchInterceptor } from '@/entrypoints/interceptor/fetch-wrapper';

describe('fetch-wrapper', () => {
    it('falls back to original fetch when interceptor throws', async () => {
        const response = new Response('ok', { status: 200 });
        const originalFetch = ((..._args: Parameters<typeof fetch>) =>
            Promise.resolve(response)) as unknown as typeof fetch;
        const originalConsoleError = console.error;
        const logged: unknown[] = [];
        console.error = (...args: unknown[]) => {
            logged.push(args);
        };

        const wrapped = createFetchInterceptor(originalFetch, () => {
            throw new Error('boom');
        });

        try {
            const result = await wrapped('https://example.com');
            expect(result.status).toBe(200);
            expect(logged.length).toBeGreaterThan(0);
        } finally {
            console.error = originalConsoleError;
        }
    });

    it('returns the interceptor response when it succeeds', async () => {
        const interceptorResponse = new Response('intercepted', { status: 202 });
        const originalFetch = (() =>
            Promise.resolve(new Response('original', { status: 200 }))) as unknown as typeof fetch;
        const wrapped = createFetchInterceptor(originalFetch, () => Promise.resolve(interceptorResponse));

        const result = await wrapped('https://example.com');
        expect(result.status).toBe(202);
    });
});
