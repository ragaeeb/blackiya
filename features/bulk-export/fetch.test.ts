import { describe, expect, it, mock } from 'bun:test';
import type { FetchContext, FetchTextResult } from './fetch';
import { fetchFirstSuccessfulResponse, fetchText, MAX_429_RETRIES } from './fetch';

const createMockContext = (overrides: Partial<FetchContext> = {}): FetchContext => ({
    fetchImpl: mock(() => Promise.resolve(new Response('', { status: 200 }))),
    sleepImpl: mock(() => Promise.resolve()),
    nowImpl: () => Date.now(),
    authHeaders: { Authorization: 'Bearer token' },
    timeoutMs: 10_000,
    platformName: 'ChatGPT',
    requestCount: 0,
    ...overrides,
});

describe('fetchText', () => {
    it('should fetch successfully with 200 response', async () => {
        const context = createMockContext({
            fetchImpl: mock(() => Promise.resolve(new Response('success data', { status: 200 }))),
        });

        const result = await fetchText('https://example.com', context);

        expect(result).toEqual({ ok: true, text: 'success data' });
        expect(context.fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('should return error for 404 response', async () => {
        const context = createMockContext({
            fetchImpl: mock(() => Promise.resolve(new Response('', { status: 404, statusText: 'Not Found' }))),
        });

        const result = await fetchText('https://example.com', context);

        expect(result).toEqual({ ok: false, status: 404, message: 'Not Found' });
    });

    it('should return error for 500 response', async () => {
        const context = createMockContext({
            fetchImpl: mock(() =>
                Promise.resolve(new Response('', { status: 500, statusText: 'Internal Server Error' })),
            ),
        });

        const result = await fetchText('https://example.com', context);

        expect(result).toEqual({ ok: false, status: 500, message: 'Internal Server Error' });
    });

    it('should retry 429 response with exponential backoff', async () => {
        let callCount = 0;
        const context = createMockContext({
            fetchImpl: mock(() => {
                callCount += 1;
                if (callCount <= 2) {
                    return Promise.resolve(new Response('', { status: 429 }));
                }
                return Promise.resolve(new Response('success', { status: 200 }));
            }),
            sleepImpl: mock(() => Promise.resolve()),
        });

        const result = await fetchText('https://example.com', context);

        expect(result).toEqual({ ok: true, text: 'success' });
        expect(context.fetchImpl).toHaveBeenCalledTimes(3);
        expect(context.sleepImpl).toHaveBeenCalledTimes(2);
    });

    it('should exhaust retries on persistent 429', async () => {
        const context = createMockContext({
            fetchImpl: mock(() => Promise.resolve(new Response('', { status: 429 }))),
            sleepImpl: mock(() => Promise.resolve()),
        });

        const result = await fetchText('https://example.com', context);

        expect(result).toEqual({ ok: false, status: 429, message: 'Rate limit retries exhausted' });
        expect(context.fetchImpl).toHaveBeenCalledTimes(MAX_429_RETRIES + 1);
    });

    it('should use retry-after header value in seconds', async () => {
        let callCount = 0;
        const context = createMockContext({
            fetchImpl: mock(() => {
                callCount += 1;
                if (callCount === 1) {
                    return Promise.resolve(
                        new Response('', {
                            status: 429,
                            headers: { 'retry-after': '2' },
                        }),
                    );
                }
                return Promise.resolve(new Response('success', { status: 200 }));
            }),
            sleepImpl: mock(() => Promise.resolve()),
        });

        await fetchText('https://example.com', context);

        expect(context.sleepImpl).toHaveBeenCalledWith(2000);
    });

    it('should handle network errors', async () => {
        const context = createMockContext({
            fetchImpl: mock(() => Promise.reject(new Error('Network failure'))),
        });

        const result = await fetchText('https://example.com', context);

        expect(result).toEqual({ ok: false, status: 0, message: 'Network failure' });
    });

    it('should pass custom headers for POST request', async () => {
        const context = createMockContext({
            fetchImpl: mock(() => Promise.resolve(new Response('ok', { status: 200 }))),
        });

        await fetchText('https://example.com', context, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"key":"value"}',
        });

        expect(context.fetchImpl).toHaveBeenCalledWith(
            'https://example.com',
            expect.objectContaining({
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{"key":"value"}',
            }),
        );
    });

    it('should default to GET with auth headers', async () => {
        const context = createMockContext({
            fetchImpl: mock(() => Promise.resolve(new Response('ok', { status: 200 }))),
            authHeaders: { Authorization: 'Bearer test-token' },
        });

        await fetchText('https://example.com', context);

        expect(context.fetchImpl).toHaveBeenCalledWith(
            'https://example.com',
            expect.objectContaining({
                method: 'GET',
                headers: { Authorization: 'Bearer test-token' },
            }),
        );
    });
});

describe('fetchFirstSuccessfulResponse', () => {
    it('should return first successful response', async () => {
        const context = createMockContext({
            fetchImpl: mock(() => Promise.resolve(new Response('success', { status: 200 }))),
        });

        const result = await fetchFirstSuccessfulResponse(['https://a.com', 'https://b.com'], context);

        expect(result).toEqual({ ok: true, text: 'success' });
        expect(context.fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('should try next URL on failure', async () => {
        let callCount = 0;
        const context = createMockContext({
            fetchImpl: mock(() => {
                callCount += 1;
                if (callCount === 1) {
                    return Promise.resolve(new Response('', { status: 404 }));
                }
                return Promise.resolve(new Response('success', { status: 200 }));
            }),
        });

        const result = await fetchFirstSuccessfulResponse(['https://a.com', 'https://b.com'], context);

        expect(result).toEqual({ ok: true, text: 'success' });
        expect(context.fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('should return last failure if all URLs fail', async () => {
        let callCount = 0;
        const context = createMockContext({
            fetchImpl: mock(() => {
                callCount += 1;
                return Promise.resolve(
                    new Response('', { status: callCount === 1 ? 404 : 500, statusText: `Error ${callCount}` }),
                );
            }),
        });

        const result = await fetchFirstSuccessfulResponse(['https://a.com', 'https://b.com'], context);

        expect(result).toEqual({ ok: false, status: 500, message: 'Error 2' });
        expect(context.fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('should return null for empty URL list', async () => {
        const context = createMockContext();

        const result = await fetchFirstSuccessfulResponse([], context);

        expect(result).toBeNull();
        expect(context.fetchImpl).not.toHaveBeenCalled();
    });
});
