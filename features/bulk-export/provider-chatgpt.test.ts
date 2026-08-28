import { describe, expect, it, mock } from 'bun:test';
import type { FetchContext } from './fetch';
import { buildChatGptDetailUrls, CHATGPT_HOSTS, listConversationIdsChatGpt } from './provider-chatgpt';

const createMockFetchContext = (overrides: Partial<FetchContext> = {}): FetchContext => ({
    fetchImpl: mock(() => Promise.resolve(new Response('', { status: 200 }))),
    sleepImpl: mock(() => Promise.resolve()),
    nowImpl: () => Date.now(),
    authHeaders: undefined,
    timeoutMs: 10_000,
    platformName: 'ChatGPT',
    requestCount: 0,
    ...overrides,
});

describe('listConversationIdsChatGpt', () => {
    it('should fetch and parse conversation IDs', async () => {
        const fetchContext = createMockFetchContext({
            fetchImpl: mock(() =>
                Promise.resolve(
                    new Response(
                        JSON.stringify({
                            items: [{ id: 'abc-def-12345678' }, { id: 'fed-cba-87654321' }],
                        }),
                        { status: 200 },
                    ),
                ),
            ),
        });

        const result = await listConversationIdsChatGpt(
            { maxItems: 100, delayMs: 1000, timeoutMs: 10000 },
            fetchContext,
            'https://chatgpt.com',
        );

        expect(result.ids).toEqual(['abc-def-12345678', 'fed-cba-87654321']);
        expect(result.warnings).toEqual([]);
    });

    it('should paginate until limit reached', async () => {
        let page = 0;
        const fetchContext = createMockFetchContext({
            fetchImpl: mock(() => {
                page += 1;
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            items: Array.from({ length: 100 }, (_, i) => ({
                                id: `abc${page}def${String(i).padStart(5, '0')}`,
                            })),
                        }),
                        { status: 200 },
                    ),
                );
            }),
        });

        const result = await listConversationIdsChatGpt(
            { maxItems: 150, delayMs: 1000, timeoutMs: 10000 },
            fetchContext,
            'https://chatgpt.com',
        );

        expect(result.ids.length).toBe(150);
        expect(fetchContext.fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('should fetch all conversations when limit is null', async () => {
        let page = 0;
        const fetchContext = createMockFetchContext({
            fetchImpl: mock(() => {
                page += 1;
                const items = page <= 2 ? 100 : 50;
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            items: Array.from({ length: items }, (_, i) => ({
                                id: `abc${page}def${String(i).padStart(5, '0')}`,
                            })),
                        }),
                        { status: 200 },
                    ),
                );
            }),
        });

        const result = await listConversationIdsChatGpt(
            { maxItems: null, delayMs: 1000, timeoutMs: 10000 },
            fetchContext,
            'https://chatgpt.com',
        );

        expect(result.ids.length).toBe(250);
        expect(fetchContext.fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('should stop pagination when a short page is returned', async () => {
        let page = 0;
        const fetchContext = createMockFetchContext({
            fetchImpl: mock(() => {
                page += 1;
                if (page === 1) {
                    return Promise.resolve(
                        new Response(JSON.stringify({ items: [{ id: 'abcdef01' }] }), { status: 200 }),
                    );
                }
                return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
            }),
        });

        const result = await listConversationIdsChatGpt(
            { maxItems: 100, delayMs: 1000, timeoutMs: 10000 },
            fetchContext,
            'https://chatgpt.com',
        );

        expect(result.ids).toEqual(['abcdef01']);
        expect(result.warnings).toEqual([]);
        expect(fetchContext.fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('should warn on fetch failure', async () => {
        const fetchContext = createMockFetchContext({
            fetchImpl: mock(() => Promise.resolve(new Response('', { status: 500, statusText: 'Server Error' }))),
        });

        const result = await listConversationIdsChatGpt(
            { maxItems: 100, delayMs: 1000, timeoutMs: 10000 },
            fetchContext,
            'https://chatgpt.com',
        );

        expect(result.ids).toEqual([]);
        expect(result.warnings).toContain('ChatGPT list endpoint failed at offset=0: status=500 message=Server Error');
    });

    it('should use correct host from location', async () => {
        const fetchContext = createMockFetchContext({
            fetchImpl: mock(() => Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }))),
        });

        await listConversationIdsChatGpt(
            { maxItems: 100, delayMs: 1000, timeoutMs: 10000 },
            fetchContext,
            'https://chat.openai.com',
        );

        const firstCall = (fetchContext.fetchImpl as any).mock.calls[0];
        expect(firstCall[0]).toContain('chat.openai.com');
    });

    it('should fallback to default host for unknown location', async () => {
        const fetchContext = createMockFetchContext({
            fetchImpl: mock(() => Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }))),
        });

        await listConversationIdsChatGpt(
            { maxItems: 100, delayMs: 1000, timeoutMs: 10000 },
            fetchContext,
            'https://unknown.com',
        );

        const firstCall = (fetchContext.fetchImpl as any).mock.calls[0];
        expect(firstCall[0]).toContain(CHATGPT_HOSTS[0]);
    });
});

describe('buildChatGptDetailUrls', () => {
    it('should build URLs from adapter methods', () => {
        const adapter = {
            name: 'ChatGPT' as const,
            buildApiUrl: (id: string) => `https://chatgpt.com/api/conversation/${id}`,
            buildApiUrls: (id: string) => [`https://chatgpt.com/api/v2/conversation/${id}`],
        } as any;

        const urls = buildChatGptDetailUrls(adapter, 'abc-def-123', 'chatgpt.com');

        expect(urls).toContain('https://chatgpt.com/api/conversation/abc-def-123');
        expect(urls).toContain('https://chatgpt.com/api/v2/conversation/abc-def-123');
        expect(urls).toContain('https://chatgpt.com/backend-api/conversation/abc-def-123');
    });

    it('should include fallback URL when adapter has no methods', () => {
        const adapter = {
            name: 'ChatGPT' as const,
        } as any;

        const urls = buildChatGptDetailUrls(adapter, 'abc-def-123', 'chatgpt.com');

        expect(urls).toEqual(['https://chatgpt.com/backend-api/conversation/abc-def-123']);
    });

    it('should deduplicate URLs', () => {
        const adapter = {
            name: 'ChatGPT' as const,
            buildApiUrl: () => 'https://chatgpt.com/backend-api/conversation/abc-def-123',
            buildApiUrls: () => ['https://chatgpt.com/backend-api/conversation/abc-def-123'],
        } as any;

        const urls = buildChatGptDetailUrls(adapter, 'abc-def-123', 'chatgpt.com');

        expect(urls).toEqual(['https://chatgpt.com/backend-api/conversation/abc-def-123']);
    });
});
