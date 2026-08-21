import { describe, expect, it } from 'bun:test';
import type { FetchContext } from './fetch';
import { fetchText } from './fetch';

const okResponse = (body = '{}') => new Response(body, { status: 200 });

const createContext = (overrides: Partial<FetchContext> = {}): FetchContext => ({
    fetchImpl: (async () => okResponse()) as unknown as typeof fetch,
    sleepImpl: async () => {},
    nowImpl: () => 1_000,
    authHeaders: undefined,
    timeoutMs: 5_000,
    platformName: 'ChatGPT',
    requestCount: 0,
    ...overrides,
});

describe('bulk export request client', () => {
    it('should pace requests and bind injected fetch to globalThis', async () => {
        const sleeps: number[] = [];
        const fetchThisValues: unknown[] = [];
        const fetchImpl = async function (this: unknown) {
            fetchThisValues.push(this);
            return okResponse();
        } as unknown as typeof fetch;
        const context = createContext({
            fetchImpl,
            sleepImpl: async (milliseconds) => {
                sleeps.push(milliseconds);
            },
            requestCount: 0,
            delayMs: 300,
        });

        await fetchText('https://example.test/one', context);
        await fetchText('https://example.test/two', context);

        expect(fetchThisValues).toEqual([globalThis, globalThis]);
        expect(sleeps).toEqual([300]);
    });

    it('should retry a 429 response using retry-after before succeeding', async () => {
        const sleeps: number[] = [];
        let attempts = 0;
        const context = createContext({
            fetchImpl: (async () => {
                attempts += 1;
                return attempts === 1
                    ? new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } })
                    : okResponse();
            }) as unknown as typeof fetch,
            sleepImpl: async (milliseconds) => {
                sleeps.push(milliseconds);
            },
            nowImpl: () => 1_000,
            delayMs: 300,
        });

        const result = await fetchText('https://example.test/retry', context);

        expect(result).toEqual({ ok: true, text: '{}' });
        expect(attempts).toBe(2);
        expect(sleeps).toContain(2_000);
    });

    it('should stop after the bounded number of 429 retries', async () => {
        let attempts = 0;
        const context = createContext({
            fetchImpl: (async () => {
                attempts += 1;
                return new Response('rate limited', { status: 429 });
            }) as unknown as typeof fetch,
            sleepImpl: async () => {},
            nowImpl: () => 1_000,
            delayMs: 300,
        });

        const result = await fetchText('https://example.test/exhausted', context);

        expect(result).toEqual({
            ok: false,
            status: 0,
            message: 'Request deadline exceeded while waiting to retry.',
        });
        expect(attempts).toBe(3);
    });

});
