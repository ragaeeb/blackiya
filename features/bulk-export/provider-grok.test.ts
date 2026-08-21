import { describe, expect, it, mock } from 'bun:test';
import type { ConversationData } from '@/utils/types';
import type { FetchContext } from './fetch';
import { fetchConversationByIdGrokCom, listConversationIdsGrokCom } from './provider-grok';

const conversationId = '53d21d0d-add5-4fd6-bfe8-136705227759';
const responseId = '5b128365-2fed-4339-a2b6-8a85a62ad182';

const createMockFetchContext = (fetchImpl: typeof fetch): FetchContext => ({
    fetchImpl,
    sleepImpl: async () => {},
    nowImpl: () => 1_000,
    authHeaders: undefined,
    timeoutMs: 5_000,
    delayMs: 300,
    platformName: 'Grok',
    requestCount: 0,
});

const adapter = {
    name: 'Grok',
    parseInterceptedData: (data: string, url: string) => {
        if (url.includes(`/reconnect-response-v2/${responseId}`)) {
            return JSON.parse(data) as ConversationData;
        }
        return null;
    },
} as any;

describe('listConversationIdsGrokCom', () => {
    it('should follow cursors and deduplicate conversation IDs', async () => {
        let page = 0;
        const fetchContext = createMockFetchContext(
            mock(async () => {
                page += 1;
                return page === 1
                    ? new Response(
                          JSON.stringify({
                              conversations: [{ conversationId }, { conversationId }],
                              nextCursor: 'next-page',
                          }),
                          { status: 200 },
                      )
                    : new Response(JSON.stringify({ conversations: [{ conversationId }] }), { status: 200 });
            }) as unknown as typeof fetch,
        );

        const result = await listConversationIdsGrokCom(
            { maxItems: null, delayMs: 300, timeoutMs: 5_000 },
            fetchContext,
        );

        expect(result.ids).toEqual([conversationId]);
        expect(fetchContext.fetchImpl).toHaveBeenCalledTimes(2);
    });
});

describe('fetchConversationByIdGrokCom', () => {
    it('should use reconnect-response-v2 after 404 detail candidates', async () => {
        const fetchedUrls: string[] = [];
        const conversation = {
            conversation_id: conversationId,
            title: 'Recovered',
        } as ConversationData;
        const fetchContext = createMockFetchContext(
            mock(async (input) => {
                const url = String(input);
                fetchedUrls.push(url);
                if (url.includes('/conversations_v2/')) {
                    return new Response('missing', { status: 404 });
                }
                if (url.includes('/response-node')) {
                    return new Response(JSON.stringify({ responseNodes: [{ responseId }] }), { status: 200 });
                }
                if (url.includes(`/reconnect-response-v2/${responseId}`)) {
                    return new Response(JSON.stringify(conversation), { status: 200 });
                }
                return new Response('missing', { status: 404 });
            }) as unknown as typeof fetch,
        );

        const result = await fetchConversationByIdGrokCom(conversationId, adapter, fetchContext);

        expect(result).toEqual(conversation);
        expect(fetchedUrls.some((url) => url.includes(`/reconnect-response-v2/${responseId}`))).toBeTrue();
    });
});
