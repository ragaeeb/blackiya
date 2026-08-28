import { describe, expect, it } from 'bun:test';
import type { ConversationData } from '@/utils/types';
import { geminiState } from '../../platforms/gemini/state';
import type { FetchContext } from './fetch';
import { fetchConversationByIdGemini, listConversationIdsGemini } from './provider-gemini';

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

    it('should fail fast without the at context instead of issuing cookie-only detail GETs', async () => {
        let requestCount = 0;
        const fetchImpl = (() => {
            requestCount += 1;
            throw new Error('detail request must not be attempted');
        }) as unknown as typeof fetch;

        const result = await fetchConversationByIdGemini(
            'gem-missing-at',
            { parseInterceptedData: () => null } as any,
            buildContext(fetchImpl),
            'https://gemini.google.com/app/gem-missing-at',
            undefined,
        );

        expect(result).toBeNull();
        expect(requestCount).toBe(0);
    });

    it('should stop the bulk run when the Gemini list request is unauthorized', async () => {
        geminiState.reset();
        geminiState.conversationTitles.set('stale-account-id', 'Stale account conversation');

        try {
            await expect(
                listConversationIdsGemini(
                    { maxItems: null, delayMs: 0, timeoutMs: 5_000 },
                    buildContext(
                        (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch,
                    ),
                    'https://gemini.google.com/app',
                    { extractConversationId: () => null } as any,
                ),
            ).rejects.toThrow('Bulk export stopped after HTTP 401 authentication failure.');
        } finally {
            geminiState.reset();
        }
    });
});
