import { describe, expect, it } from 'bun:test';
import type { ConversationData } from '@/utils/types';
import type { FetchContext } from './fetch';
import { fetchConversationByIdGemini } from './provider-gemini';

const buildContext = (fetchImpl: typeof fetch): FetchContext => ({
    fetchImpl,
    sleepImpl: async () => {},
    nowImpl: () => 1_000,
    authHeaders: { authorization: 'Bearer test' },
    timeoutMs: 5_000,
    delayMs: 300,
    platformName: 'Gemini',
    requestCount: 0,
});

describe('fetchConversationByIdGemini', () => {
    it('should use the hNvQHb POST detail request with captured batchexecute context', async () => {
        const conversation = { conversation_id: 'gem-post-1', title: 'Gemini title' } as ConversationData;
        const adapter = {
            parseInterceptedData: (data: string) => JSON.parse(data) as ConversationData,
        } as any;
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            expect(url).toContain('rpcids=hNvQHb');
            expect(init?.method).toBe('POST');
            expect(String(init?.body)).toContain('f.req=');
            expect(String(init?.body)).toContain('c_gem-post-1');
            expect(String(init?.body)).toContain('at=test-at');
            return new Response(JSON.stringify(conversation), { status: 200 });
        }) as unknown as typeof fetch;

        const result = await fetchConversationByIdGemini(
            'gem-post-1',
            adapter,
            buildContext(fetchImpl),
            'https://gemini.google.com/app/gem-post-1',
            {
                at: 'test-at',
                bl: 'test-bl',
                fSid: 'test-fsid',
                hl: 'en',
                reqid: 10,
                rt: 'c',
                updatedAt: 1_000,
            },
        );

        expect(result).toEqual(conversation);
    });
});
