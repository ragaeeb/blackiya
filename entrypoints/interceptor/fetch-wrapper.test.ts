import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createFetchInterceptor } from '@/entrypoints/interceptor/fetch-wrapper';

describe('fetch-wrapper', () => {
    let originalConsoleDebug: typeof console.debug;
    const logged: unknown[] = [];

    beforeEach(() => {
        logged.length = 0;
        originalConsoleDebug = console.debug;
        console.debug = (...args: unknown[]) => {
            logged.push(args);
        };
    });

    afterEach(() => {
        console.debug = originalConsoleDebug;
    });

    it('falls back to original fetch when interceptor throws', async () => {
        const response = new Response('ok', { status: 200 });
        const originalFetch = ((..._args: Parameters<typeof fetch>) =>
            Promise.resolve(response)) as unknown as typeof fetch;

        const wrapped = createFetchInterceptor(originalFetch, () => {
            throw new Error('boom');
        });

        const result = await wrapped('https://example.com');
        expect(result.status).toBe(200);
        expect(logged.length).toBeGreaterThan(0);
    });

    it('returns the interceptor response when it succeeds', async () => {
        const interceptorResponse = new Response('intercepted', { status: 202 });
        const originalFetch = (() =>
            Promise.resolve(new Response('original', { status: 200 }))) as unknown as typeof fetch;
        const wrapped = createFetchInterceptor(originalFetch, () => Promise.resolve(interceptorResponse));

        const result = await wrapped('https://example.com');
        expect(result.status).toBe(202);
    });

    it('resolves URL from a URL object when interceptor throws', async () => {
        const originalFetch = (() => Promise.resolve(new Response('ok', { status: 200 }))) as unknown as typeof fetch;
        const wrapped = createFetchInterceptor(originalFetch, () => {
            throw new Error('url-object-error');
        });

        const result = await wrapped(new URL('https://example.com/path'));
        expect(result.status).toBe(200);
        const logEntry = logged[0] as unknown[];
        expect(JSON.stringify(logEntry)).toContain('https://example.com/path');
    });

    it('resolves URL from a Request object when interceptor throws', async () => {
        const originalFetch = (() => Promise.resolve(new Response('ok', { status: 200 }))) as unknown as typeof fetch;
        const wrapped = createFetchInterceptor(originalFetch, () => {
            throw new Error('request-error');
        });

        const request = new Request('https://example.com/api');
        const result = await wrapped(request);
        expect(result.status).toBe(200);
        const logEntry = logged[0] as unknown[];
        expect(JSON.stringify(logEntry)).toContain('https://example.com/api');
    });

    it('uses method from init when interceptor throws', async () => {
        const originalFetch = (() => Promise.resolve(new Response('ok', { status: 200 }))) as unknown as typeof fetch;
        const wrapped = createFetchInterceptor(originalFetch, () => {
            throw new Error('method-test');
        });

        await wrapped('https://example.com', { method: 'POST' });
        const logEntry = JSON.stringify(logged[0]);
        expect(logEntry).toContain('POST');
    });

    it('uses method from Request object when init method is absent', async () => {
        const originalFetch = (() => Promise.resolve(new Response('ok', { status: 200 }))) as unknown as typeof fetch;
        const wrapped = createFetchInterceptor(originalFetch, () => {
            throw new Error('request-method-error');
        });

        const request = new Request('https://example.com/api', { method: 'DELETE' });
        await wrapped(request);
        const logEntry = JSON.stringify(logged[0]);
        expect(logEntry).toContain('DELETE');
    });

    it('suppresses duplicate error logs within the TTL window for the same URL and method', async () => {
        const originalFetch = (() => Promise.resolve(new Response('ok', { status: 200 }))) as unknown as typeof fetch;
        const wrapped = createFetchInterceptor(originalFetch, () => {
            throw new Error('dup');
        });

        // Two calls to the same URL in rapid succession — only one log should be emitted.
        await wrapped('https://example.com/dedup');
        await wrapped('https://example.com/dedup');
        expect(logged.length).toBe(1);
    });

    it('logs non-Error thrown values as strings', async () => {
        const originalFetch = (() => Promise.resolve(new Response('ok', { status: 200 }))) as unknown as typeof fetch;
        const wrapped = createFetchInterceptor(originalFetch, () => {
            throw 'plain string error'; // intentional non-Error throw to test String coercion in error handler
        });

        await wrapped('https://example.com/str-err');
        const logEntry = JSON.stringify(logged[0]);
        expect(logEntry).toContain('plain string error');
    });
});
