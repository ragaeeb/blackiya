import { describe, expect, it, mock } from 'bun:test';
import type { FetchContext } from './fetch';
import { fetchFirstSuccessfulResponse, fetchText, MAX_429_RETRIES, MAX_429_RETRY_DELAY_MS } from './fetch';

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

    it('should notify the provider context invalidator on 401 and 403 responses', async () => {
        for (const [platformName, status] of [
            ['ChatGPT', 401],
            ['Gemini', 403],
        ] as const) {
            const invalidateAuthContext = mock();
            const context = createMockContext({
                platformName,
                invalidateAuthContext,
                fetchImpl: mock(() => Promise.resolve(new Response('', { status }))),
            });

            await expect(fetchText(`https://${platformName.toLowerCase()}.example/auth`, context)).rejects.toThrow(
                `Bulk export stopped after HTTP ${status} authentication failure.`,
            );

            expect(invalidateAuthContext).toHaveBeenCalledWith(platformName);
        }
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

    it('should cap an excessive retry-after delay', async () => {
        let callCount = 0;
        const context = createMockContext({
            timeoutMs: 60_000,
            fetchImpl: mock(() => {
                callCount += 1;
                return callCount === 1
                    ? Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '86400' } }))
                    : Promise.resolve(new Response('success', { status: 200 }));
            }),
            sleepImpl: mock(() => Promise.resolve()),
        });

        await fetchText('https://example.com/capped-retry', context);

        expect(context.sleepImpl).toHaveBeenCalledWith(MAX_429_RETRY_DELAY_MS);
    });

    it('should stop before retrying when the retry delay reaches the request deadline', async () => {
        let now = 0;
        let attempts = 0;
        const context = createMockContext({
            timeoutMs: 1_000,
            nowImpl: () => now,
            fetchImpl: mock(() => {
                attempts += 1;
                return Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '30' } }));
            }),
            sleepImpl: mock(async (milliseconds: number) => {
                now += milliseconds;
            }),
        });

        const result = await fetchText('https://example.com/deadline', context);

        expect(result).toMatchObject({ ok: false, status: 0 });
        expect(attempts).toBe(1);
        expect(context.sleepImpl).toHaveBeenCalledWith(1_000);
    });

    it('should abort retry sleep when the request signal is aborted', async () => {
        const abortController = new AbortController();
        let attempts = 0;
        const context = createMockContext({
            fetchImpl: mock(() => {
                attempts += 1;
                return Promise.resolve(new Response('', { status: 429 }));
            }),
            sleepImpl: mock(async () => {
                abortController.abort();
                await new Promise<void>(() => {});
            }),
        });

        const result = await fetchText('https://example.com/aborted-retry', context, {
            signal: abortController.signal,
        });

        expect(result).toMatchObject({ ok: false, status: 0 });
        if (result.ok) {
            throw new Error('expected aborted retry to fail');
        }
        expect(result.message).toContain('aborted');
        expect(attempts).toBe(1);
    });

    it('should handle network errors', async () => {
        const context = createMockContext({
            fetchImpl: mock(() => Promise.reject(new Error('Network failure'))),
        });

        const result = await fetchText('https://example.com', context);

        expect(result).toEqual({ ok: false, status: 0, message: 'Network failure' });
    });

    it('should time out while reading a stalled response body', async () => {
        const response = {
            headers: new Headers(),
            ok: true,
            status: 200,
            statusText: 'OK',
            text: () => new Promise<string>(() => {}),
        } as Response;
        const context = createMockContext({
            timeoutMs: 5,
            fetchImpl: mock(() => Promise.resolve(response)),
        });

        const result = await fetchText('https://example.com/stalled', context);

        expect(result).toMatchObject({ ok: false, status: 0 });
        if (result.ok) {
            throw new Error('expected the stalled response body to time out');
        }
        expect(result.message).toContain('timed out');
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
