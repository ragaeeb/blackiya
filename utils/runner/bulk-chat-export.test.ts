import { describe, expect, it } from 'bun:test';
import { geminiState, resetGeminiAdapterState } from '@/platforms/gemini/state';
import type { LLMPlatform } from '@/platforms/types';
import { __testables__, runBulkChatExport } from '@/utils/runner/bulk-chat-export';
import { EXPORT_FORMAT } from '@/utils/settings';
import type { ConversationData } from '@/utils/types';

const buildConversation = (conversationId: string, title = 'Title'): ConversationData => {
    const userId = `${conversationId}-user`;
    const assistantId = `${conversationId}-assistant`;
    return {
        title,
        create_time: 1,
        update_time: 2,
        conversation_id: conversationId,
        current_node: assistantId,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: 'gpt-5',
        safe_urls: [],
        blocked_urls: [],
        mapping: {
            [userId]: {
                id: userId,
                parent: null,
                children: [assistantId],
                message: {
                    id: userId,
                    author: { role: 'user', name: 'user', metadata: {} },
                    create_time: 1,
                    update_time: 1,
                    content: { content_type: 'text', parts: ['prompt'] },
                    status: 'finished_successfully',
                    end_turn: true,
                    weight: 1,
                    metadata: {},
                    recipient: 'all',
                    channel: null,
                },
            },
            [assistantId]: {
                id: assistantId,
                parent: userId,
                children: [],
                message: {
                    id: assistantId,
                    author: { role: 'assistant', name: 'assistant', metadata: {} },
                    create_time: 2,
                    update_time: 2,
                    content: { content_type: 'text', parts: ['response'] },
                    status: 'finished_successfully',
                    end_turn: true,
                    weight: 1,
                    metadata: {},
                    recipient: 'all',
                    channel: null,
                },
            },
        },
    };
};

const buildAdapter = (): LLMPlatform => ({
    name: 'ChatGPT',
    urlMatchPattern: 'https://chatgpt.com/*',
    apiEndpointPattern: /conversation\//i,
    isPlatformUrl: () => true,
    extractConversationId: () => null,
    parseInterceptedData: (data: string) => {
        try {
            return JSON.parse(data) as ConversationData;
        } catch {
            return null;
        }
    },
    formatFilename: (data) => data.title,
    getButtonInjectionTarget: () => null,
    buildApiUrls: (conversationId) => [
        `https://chatgpt.com/backend-api/conversation/${conversationId}?candidate=1`,
        `https://chatgpt.com/backend-api/conversation/${conversationId}?candidate=2`,
    ],
});

const buildGeminiAdapter = (): LLMPlatform => ({
    name: 'Gemini',
    urlMatchPattern: 'https://gemini.google.com/*',
    apiEndpointPattern: /batchexecute/i,
    completionTriggerPattern: /batchexecute/i,
    isPlatformUrl: () => true,
    extractConversationId: () => null,
    parseInterceptedData: (data: string) => {
        try {
            return JSON.parse(data) as ConversationData;
        } catch {
            return null;
        }
    },
    formatFilename: (data) => data.title,
    getButtonInjectionTarget: () => null,
});

describe('bulk-chat-export', () => {
    it('should normalize options and treat limit=0 as all', () => {
        const normalized = __testables__.normalizeOptions({ type: 'BLACKIYA_BULK_EXPORT_CHATS', limit: 0 });
        expect(normalized.maxItems).toBeNull();
        expect(normalized.delayMs).toBeGreaterThanOrEqual(250);
        expect(normalized.timeoutMs).toBeGreaterThanOrEqual(5000);
    });

    it('should parse chatgpt conversation ids from list payload', () => {
        const ids = __testables__.extractChatGptConversationIdsFromPayload({
            items: [
                { id: '69a85cf1-4bcc-832b-b221-d582b0c9910a' },
                { conversation_id: '69a85cf1-4bcc-832b-b221-d582b0c9910a' },
                { id: '69a85cf1-4bcc-832b-b221-d582b0c9910b' },
            ],
        });
        expect(ids).toEqual(['69a85cf1-4bcc-832b-b221-d582b0c9910a', '69a85cf1-4bcc-832b-b221-d582b0c9910b']);
    });

    it('should parse chatgpt conversation ids from nested list payload variants', () => {
        const ids = __testables__.extractChatGptConversationIdsFromPayload({
            data: {
                conversations: [
                    { id: '69a85cf1-4bcc-832b-b221-d582b0c9910a' },
                    { conversation: { id: '69a85cf1-4bcc-832b-b221-d582b0c9910b' } },
                ],
            },
        });
        expect(ids).toEqual(['69a85cf1-4bcc-832b-b221-d582b0c9910a', '69a85cf1-4bcc-832b-b221-d582b0c9910b']);
    });

    it('should parse chatgpt conversation ids from prefixed list response text', () => {
        const ids = __testables__.extractChatGptConversationIdsFromText(
            `for(;;);{"items":[{"id":"69a85cf1-4bcc-832b-b221-d582b0c9910a"},{"conversation_id":"69a85cf1-4bcc-832b-b221-d582b0c9910b"}]}`,
        );
        expect(ids).toEqual(['69a85cf1-4bcc-832b-b221-d582b0c9910a', '69a85cf1-4bcc-832b-b221-d582b0c9910b']);
    });

    it('should parse gemini conversation ids from batchexecute payload text', () => {
        const responseText = `)]}'\n\n[["wrb.fr","MaZiqc","[null,null,[["c_abc12345","Title"],["c_def67890","Title 2"]]]",null]]`;
        const ids = __testables__.extractGeminiConversationIdsFromBatchexecuteText(responseText);
        expect(ids).toEqual(['abc12345', 'def67890']);
    });

    it('should parse grok.com conversation ids from conversationId payload fields', () => {
        const ids = __testables__.extractGrokComConversationIdsFromPayload({
            conversations: [
                { conversationId: '53d21d0d-add5-4fd6-bfe8-136705227759' },
                { conversationId: '4044d6ba-0dcb-4c3c-aaba-ef92cdb543b0' },
            ],
        });
        expect(ids).toEqual(['53d21d0d-add5-4fd6-bfe8-136705227759', '4044d6ba-0dcb-4c3c-aaba-ef92cdb543b0']);
    });

    it('should parse grok.com conversation ids from list response text fallback', () => {
        const ids = __testables__.extractGrokComConversationIdsFromText(
            '{"conversations":[{"conversationId":"53d21d0d-add5-4fd6-bfe8-136705227759"},{"id":"4044d6ba-0dcb-4c3c-aaba-ef92cdb543b0"}]}',
        );
        expect(ids).toEqual(['53d21d0d-add5-4fd6-bfe8-136705227759', '4044d6ba-0dcb-4c3c-aaba-ef92cdb543b0']);
    });

    it('should parse grok reconnect response ids from response-node payload text', () => {
        const responseIds = __testables__.extractGrokResponseIdsFromNodeText(
            JSON.stringify({
                responseNodes: [
                    { responseId: 'f2bd497d-d19b-4a08-9453-58dcdaf9238e', sender: 'human' },
                    {
                        responseId: '5b128365-2fed-4339-a2b6-8a85a62ad182',
                        sender: 'ASSISTANT',
                        parentResponseId: 'f2bd497d-d19b-4a08-9453-58dcdaf9238e',
                    },
                ],
                inflightResponses: [{ responseId: '5b128365-2fed-4339-a2b6-8a85a62ad182' }],
            }),
        );
        expect(responseIds).toEqual(['f2bd497d-d19b-4a08-9453-58dcdaf9238e', '5b128365-2fed-4339-a2b6-8a85a62ad182']);
    });

    it('should export conversations, fallback on 404 detail candidate, and respect limit', async () => {
        const downloads: Array<{ payload: unknown; filename: string }> = [];
        const fetchedUrls: string[] = [];
        const convA = buildConversation('69a85cf1-4bcc-832b-b221-d582b0c9910a', 'Conversation A');
        const convB = buildConversation('69a85cf1-4bcc-832b-b221-d582b0c9910b', 'Conversation B');

        const result = await runBulkChatExport(
            {
                type: 'BLACKIYA_BULK_EXPORT_CHATS',
                limit: 2,
                delayMs: 1,
                timeoutMs: 5000,
            },
            {
                getAdapter: () => buildAdapter(),
                getExportFormat: async () => EXPORT_FORMAT.ORIGINAL,
                buildExportPayloadForFormat: (data) => data,
                getAuthHeaders: () => ({ authorization: 'Bearer test' }),
                locationHref: () => 'https://chatgpt.com/c/abc',
                sleepImpl: async () => {},
                downloadImpl: (payload, filename) => {
                    downloads.push({ payload, filename });
                },
                fetchImpl: (async (input) => {
                    const url = String(input);
                    fetchedUrls.push(url);
                    if (url.includes('/backend-api/conversations?')) {
                        return new Response(
                            JSON.stringify({
                                items: [{ id: convA.conversation_id }, { id: convB.conversation_id }],
                            }),
                            { status: 200 },
                        );
                    }
                    if (url.includes(`${convA.conversation_id}?candidate=1`)) {
                        return new Response('missing', { status: 404 });
                    }
                    if (url.includes(`${convA.conversation_id}?candidate=2`)) {
                        return new Response(JSON.stringify(convA), { status: 200 });
                    }
                    if (url.includes(`${convB.conversation_id}?candidate=1`)) {
                        return new Response(JSON.stringify(convB), { status: 200 });
                    }
                    return new Response('not found', { status: 404 });
                }) as typeof fetch,
            },
        );

        expect(fetchedUrls.some((url) => url.includes(`${convA.conversation_id}?candidate=1`))).toBeTrue();
        expect(fetchedUrls.some((url) => url.includes(`${convA.conversation_id}?candidate=2`))).toBeTrue();
        expect(downloads).toHaveLength(2);
        expect(result.discovered).toBe(2);
        expect(result.exported).toBe(2);
        expect(result.failed).toBe(0);

        const exportedPayload = downloads[0]?.payload as Record<string, unknown>;
        expect((exportedPayload.__blackiya as { exportMeta?: { fidelity?: string } }).exportMeta?.fidelity).toBe(
            'high',
        );
    });

    it('should back off on 429 responses using retry-after', async () => {
        const sleeps: number[] = [];
        let listAttempts = 0;

        const result = await runBulkChatExport(
            {
                type: 'BLACKIYA_BULK_EXPORT_CHATS',
                limit: 1,
                delayMs: 300,
                timeoutMs: 5000,
            },
            {
                getAdapter: () => buildAdapter(),
                getExportFormat: async () => EXPORT_FORMAT.ORIGINAL,
                buildExportPayloadForFormat: (data) => data,
                getAuthHeaders: () => undefined,
                locationHref: () => 'https://chatgpt.com/c/abc',
                sleepImpl: async (milliseconds) => {
                    sleeps.push(milliseconds);
                },
                downloadImpl: () => {},
                fetchImpl: (async (input) => {
                    const url = String(input);
                    if (url.includes('/backend-api/conversations?')) {
                        listAttempts += 1;
                        if (listAttempts === 1) {
                            return new Response('rate limited', {
                                status: 429,
                                headers: { 'retry-after': '2' },
                            });
                        }
                        return new Response(JSON.stringify({ items: [] }), { status: 200 });
                    }
                    return new Response('not found', { status: 404 });
                }) as typeof fetch,
            },
        );

        expect(listAttempts).toBe(2);
        expect(sleeps.some((value) => value >= 2000)).toBeTrue();
        expect(result.exported).toBe(0);
    });

    it('should surface chatgpt list fetch status in warnings when list endpoint fails', async () => {
        const result = await runBulkChatExport(
            {
                type: 'BLACKIYA_BULK_EXPORT_CHATS',
                limit: 1,
                delayMs: 1,
                timeoutMs: 5000,
            },
            {
                getAdapter: () => buildAdapter(),
                getExportFormat: async () => EXPORT_FORMAT.ORIGINAL,
                buildExportPayloadForFormat: (data) => data,
                getAuthHeaders: () => ({ authorization: 'Bearer test' }),
                locationHref: () => 'https://chatgpt.com/c/abc',
                sleepImpl: async () => {},
                downloadImpl: () => {},
                fetchImpl: (async (input) => {
                    const url = String(input);
                    if (url.includes('/backend-api/conversations?')) {
                        return new Response('missing', { status: 404, statusText: 'Not Found' });
                    }
                    return new Response('not found', { status: 404 });
                }) as typeof fetch,
            },
        );

        expect(result.discovered).toBe(0);
        expect(result.warnings.some((warning) => warning.includes('ChatGPT list endpoint failed'))).toBeTrue();
        expect(result.warnings.some((warning) => warning.includes('status=404'))).toBeTrue();
    });

    it('should call fetch with global binding to avoid illegal invocation', async () => {
        const result = await runBulkChatExport(
            {
                type: 'BLACKIYA_BULK_EXPORT_CHATS',
                limit: 1,
                delayMs: 1,
                timeoutMs: 5000,
            },
            {
                getAdapter: () => buildAdapter(),
                getExportFormat: async () => EXPORT_FORMAT.ORIGINAL,
                buildExportPayloadForFormat: (data) => data,
                getAuthHeaders: () => ({ authorization: 'Bearer test' }),
                locationHref: () => 'https://chatgpt.com/c/abc',
                sleepImpl: async () => {},
                downloadImpl: () => {},
                fetchImpl: async function (this: unknown, input: RequestInfo | URL) {
                    if (this !== globalThis) {
                        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
                    }
                    const url = String(input);
                    if (url.includes('/backend-api/conversations?')) {
                        return new Response(JSON.stringify({ items: [] }), { status: 200 });
                    }
                    return new Response('not found', { status: 404 });
                } as typeof fetch,
            },
        );

        expect(result.discovered).toBe(0);
        expect(result.warnings.some((warning) => warning.includes('Illegal invocation'))).toBeFalse();
    });

    it('should fall back to cached gemini title ids when MaZiqc list parsing returns empty', async () => {
        resetGeminiAdapterState();
        geminiState.conversationTitles.set('gem-cache-1', 'Cached One');
        geminiState.conversationTitles.set('gem-cache-2', 'Cached Two');

        const conv1 = buildConversation('gem-cache-1', 'Gemini A');
        const conv2 = buildConversation('gem-cache-2', 'Gemini B');

        try {
            const result = await runBulkChatExport(
                {
                    type: 'BLACKIYA_BULK_EXPORT_CHATS',
                    limit: 2,
                    delayMs: 1,
                    timeoutMs: 5000,
                },
                {
                    getAdapter: () => buildGeminiAdapter(),
                    getExportFormat: async () => EXPORT_FORMAT.ORIGINAL,
                    buildExportPayloadForFormat: (data) => data,
                    getAuthHeaders: () => undefined,
                    locationHref: () => 'https://gemini.google.com/app/current-conv-id',
                    sleepImpl: async () => {},
                    downloadImpl: () => {},
                    fetchImpl: (async (input) => {
                        const url = String(input);
                        if (url.includes('rpcids=MaZiqc')) {
                            return new Response(`)]}'\n\n[["wrb.fr","MaZiqc","[null,null,[]]",null]]`, { status: 200 });
                        }
                        if (url.includes('conversation_id=gem-cache-1') || url.includes('/app/gem-cache-1')) {
                            return new Response(JSON.stringify(conv1), { status: 200 });
                        }
                        if (url.includes('conversation_id=gem-cache-2') || url.includes('/app/gem-cache-2')) {
                            return new Response(JSON.stringify(conv2), { status: 200 });
                        }
                        return new Response('not found', { status: 404 });
                    }) as typeof fetch,
                },
            );

            expect(result.discovered).toBe(2);
            expect(result.exported).toBe(2);
            expect(result.warnings.some((warning) => warning.includes('No conversations discovered'))).toBeFalse();
        } finally {
            resetGeminiAdapterState();
        }
    });

    it('should fall back to cached gemini title ids when MaZiqc list request fails', async () => {
        resetGeminiAdapterState();
        geminiState.conversationTitles.set('gem-cache-fail-1', 'Cached One');

        const conv1 = buildConversation('gem-cache-fail-1', 'Gemini A');

        try {
            const result = await runBulkChatExport(
                {
                    type: 'BLACKIYA_BULK_EXPORT_CHATS',
                    limit: 1,
                    delayMs: 1,
                    timeoutMs: 5000,
                },
                {
                    getAdapter: () => buildGeminiAdapter(),
                    getExportFormat: async () => EXPORT_FORMAT.ORIGINAL,
                    buildExportPayloadForFormat: (data) => data,
                    getAuthHeaders: () => undefined,
                    locationHref: () => 'https://gemini.google.com/app/current-conv-id',
                    sleepImpl: async () => {},
                    downloadImpl: () => {},
                    fetchImpl: (async (input) => {
                        const url = String(input);
                        if (url.includes('rpcids=MaZiqc')) {
                            return new Response('bad request', { status: 400, statusText: 'Bad Request' });
                        }
                        if (url.includes('conversation_id=gem-cache-fail-1') || url.includes('/app/gem-cache-fail-1')) {
                            return new Response(JSON.stringify(conv1), { status: 200 });
                        }
                        return new Response('not found', { status: 404 });
                    }) as typeof fetch,
                },
            );

            expect(result.discovered).toBe(1);
            expect(result.exported).toBe(1);
            expect(
                result.warnings.some((warning) => warning.includes('falling back to cached Gemini title ids')),
            ).toBeTrue();
        } finally {
            resetGeminiAdapterState();
        }
    });

    it('should use Gemini hNvQHb POST detail request with captured batchexecute context', async () => {
        resetGeminiAdapterState();
        geminiState.conversationTitles.set('gem-post-1', 'Cached One');
        const conv1 = buildConversation('gem-post-1', 'Gemini Post');

        try {
            const result = await runBulkChatExport(
                {
                    type: 'BLACKIYA_BULK_EXPORT_CHATS',
                    limit: 1,
                    delayMs: 1,
                    timeoutMs: 5000,
                },
                {
                    getAdapter: () => buildGeminiAdapter(),
                    getExportFormat: async () => EXPORT_FORMAT.ORIGINAL,
                    buildExportPayloadForFormat: (data) => data,
                    getAuthHeaders: () => ({ 'x-same-domain': '1' }),
                    getGeminiBatchexecuteContext: () => ({
                        bl: 'boq_assistant-bard-web-server_20260301.05_p0',
                        fSid: '417258539017459521',
                        hl: 'en',
                        rt: 'c',
                        reqid: 3_158_273,
                        at: 'AJvLN6NezlSmBcmLwXGIMy4gwUP8:1772658672573',
                        updatedAt: Date.now(),
                    }),
                    locationHref: () => 'https://gemini.google.com/app/gem-post-1',
                    sleepImpl: async () => {},
                    downloadImpl: () => {},
                    fetchImpl: (async (input, init) => {
                        const url = String(input);
                        if (url.includes('rpcids=MaZiqc')) {
                            return new Response('bad request', { status: 400, statusText: 'Bad Request' });
                        }
                        if (url.includes('rpcids=hNvQHb')) {
                            expect(init?.method).toBe('POST');
                            const body = String(init?.body ?? '');
                            expect(body.includes('f.req=')).toBeTrue();
                            expect(body.includes('at=AJvLN6NezlSmBcmLwXGIMy4gwUP8%3A1772658672573')).toBeTrue();
                            expect(body.includes('c_gem-post-1')).toBeTrue();
                            return new Response(JSON.stringify(conv1), { status: 200 });
                        }
                        return new Response('not found', { status: 404 });
                    }) as typeof fetch,
                },
            );

            expect(result.discovered).toBe(1);
            expect(result.exported).toBe(1);
            expect(result.failed).toBe(0);
        } finally {
            resetGeminiAdapterState();
        }
    });

    it('should use observed x-grok detail query id and features for conversation detail fetch', async () => {
        const fetchedUrls: string[] = [];
        const conversationId = '2029114150362702208';
        const conv = buildConversation(conversationId, 'X Grok Conversation');
        const grokAdapter: LLMPlatform = {
            ...buildAdapter(),
            name: 'Grok',
            parseInterceptedData: (data: string) => {
                try {
                    return JSON.parse(data) as ConversationData;
                } catch {
                    return null;
                }
            },
        };

        const result = await runBulkChatExport(
            {
                type: 'BLACKIYA_BULK_EXPORT_CHATS',
                limit: 1,
                delayMs: 1,
                timeoutMs: 5000,
            },
            {
                getAdapter: () => grokAdapter,
                getExportFormat: async () => EXPORT_FORMAT.ORIGINAL,
                buildExportPayloadForFormat: (data) => data,
                getAuthHeaders: () => ({ authorization: 'Bearer test' }),
                getXGrokGraphqlContext: () => ({
                    queryId: 'n2bhau0B2DSY6R_bLolgSg',
                    features: '{"responsive_web_grok_annotations_enabled":true}',
                    updatedAt: Date.now(),
                }),
                locationHref: () => 'https://x.com/i/grok?conversation=2029114150362702208',
                sleepImpl: async () => {},
                downloadImpl: () => {},
                fetchImpl: (async (input) => {
                    const url = String(input);
                    fetchedUrls.push(url);
                    if (url.includes('/i/api/graphql/9Hyh5D4-WXLnExZkONSkZg/GrokHistory')) {
                        return new Response(
                            JSON.stringify({
                                data: {
                                    grok_conversation_history: {
                                        items: [{ rest_id: conversationId }],
                                        cursor: null,
                                    },
                                },
                            }),
                            { status: 200 },
                        );
                    }
                    if (url.includes('/i/api/graphql/n2bhau0B2DSY6R_bLolgSg/GrokConversationItemsByRestId')) {
                        expect(url.includes('features=')).toBeTrue();
                        return new Response(JSON.stringify(conv), { status: 200 });
                    }
                    return new Response('not found', { status: 404 });
                }) as typeof fetch,
            },
        );

        expect(result.discovered).toBe(1);
        expect(result.exported).toBe(1);
        expect(
            fetchedUrls.some(
                (url) =>
                    url.includes('/i/api/graphql/n2bhau0B2DSY6R_bLolgSg/GrokConversationItemsByRestId') &&
                    url.includes('features='),
            ),
        ).toBeTrue();
    });

    it('should surface grok list fetch status in warnings when list endpoint fails', async () => {
        const grokAdapter: LLMPlatform = {
            ...buildAdapter(),
            name: 'Grok',
        };

        const result = await runBulkChatExport(
            {
                type: 'BLACKIYA_BULK_EXPORT_CHATS',
                limit: 1,
                delayMs: 1,
                timeoutMs: 5000,
            },
            {
                getAdapter: () => grokAdapter,
                getExportFormat: async () => EXPORT_FORMAT.ORIGINAL,
                buildExportPayloadForFormat: (data) => data,
                getAuthHeaders: () => undefined,
                locationHref: () => 'https://grok.com/c/53d21d0d-add5-4fd6-bfe8-136705227759',
                sleepImpl: async () => {},
                downloadImpl: () => {},
                fetchImpl: (async (input) => {
                    const url = String(input);
                    if (url.includes('/rest/app-chat/conversations?pageSize=')) {
                        return new Response('bad request', { status: 400, statusText: 'Bad Request' });
                    }
                    return new Response('not found', { status: 404 });
                }) as typeof fetch,
            },
        );

        expect(result.discovered).toBe(0);
        expect(result.warnings.some((warning) => warning.includes('Grok list endpoint failed'))).toBeTrue();
        expect(result.warnings.some((warning) => warning.includes('status=400'))).toBeTrue();
    });

    it('should fetch grok reconnect-response-v2 when detail candidates return no parseable payload', async () => {
        const fetchedUrls: string[] = [];
        const conversationA = '4044d6ba-0dcb-4c3c-aaba-ef92cdb543b0';
        const conversationB = '53d21d0d-add5-4fd6-bfe8-136705227759';
        const reconnectResponseId = '5b128365-2fed-4339-a2b6-8a85a62ad182';
        const convA = buildConversation(conversationA, 'Grok A');
        const convB = buildConversation(conversationB, 'Grok B');

        const grokAdapter: LLMPlatform = {
            ...buildAdapter(),
            name: 'Grok',
            buildApiUrls: undefined,
            parseInterceptedData: (_data: string, url: string) => {
                if (url.includes(`/conversations_v2/${conversationA}`)) {
                    return convA;
                }
                if (url.includes(`/reconnect-response-v2/${reconnectResponseId}`)) {
                    return convB;
                }
                return null;
            },
        };

        const result = await runBulkChatExport(
            {
                type: 'BLACKIYA_BULK_EXPORT_CHATS',
                limit: 2,
                delayMs: 1,
                timeoutMs: 5000,
            },
            {
                getAdapter: () => grokAdapter,
                getExportFormat: async () => EXPORT_FORMAT.ORIGINAL,
                buildExportPayloadForFormat: (data) => data,
                getAuthHeaders: () => undefined,
                locationHref: () => `https://grok.com/c/${conversationA}`,
                sleepImpl: async () => {},
                downloadImpl: () => {},
                fetchImpl: (async (input) => {
                    const url = String(input);
                    fetchedUrls.push(url);
                    if (url.includes('/rest/app-chat/conversations?pageSize=')) {
                        return new Response(
                            JSON.stringify({
                                conversations: [{ conversationId: conversationA }, { conversationId: conversationB }],
                            }),
                            { status: 200 },
                        );
                    }
                    if (url.includes(`/conversations_v2/${conversationA}`)) {
                        return new Response(JSON.stringify({ conversation: { conversationId: conversationA } }), {
                            status: 200,
                        });
                    }
                    if (url.includes(`/conversations_v2/${conversationB}`)) {
                        return new Response(JSON.stringify({ conversation: { conversationId: conversationB } }), {
                            status: 200,
                        });
                    }
                    if (url.includes(`/conversations/${conversationB}/response-node`)) {
                        return new Response(
                            JSON.stringify({
                                responseNodes: [
                                    { responseId: 'f2bd497d-d19b-4a08-9453-58dcdaf9238e', sender: 'human' },
                                    { responseId: reconnectResponseId, sender: 'ASSISTANT' },
                                ],
                            }),
                            { status: 200 },
                        );
                    }
                    if (url.includes(`/reconnect-response-v2/${reconnectResponseId}`)) {
                        return new Response('{"ok":true}', { status: 200 });
                    }
                    return new Response('not found', { status: 404 });
                }) as typeof fetch,
            },
        );

        expect(result.discovered).toBe(2);
        expect(result.exported).toBe(2);
        expect(result.failed).toBe(0);
        expect(fetchedUrls.some((url) => url.includes(`/reconnect-response-v2/${reconnectResponseId}`))).toBeTrue();
    });

    it('should not call grok load-responses endpoint during bulk detail fetch fallback', async () => {
        const conversationId = '53d21d0d-add5-4fd6-bfe8-136705227759';
        const fetchedUrls: string[] = [];
        const grokAdapter: LLMPlatform = {
            ...buildAdapter(),
            name: 'Grok',
            buildApiUrls: undefined,
        };

        const result = await runBulkChatExport(
            {
                type: 'BLACKIYA_BULK_EXPORT_CHATS',
                limit: 1,
                delayMs: 1,
                timeoutMs: 5000,
            },
            {
                getAdapter: () => grokAdapter,
                getExportFormat: async () => EXPORT_FORMAT.ORIGINAL,
                buildExportPayloadForFormat: (data) => data,
                getAuthHeaders: () => undefined,
                locationHref: () => 'https://grok.com/c/53d21d0d-add5-4fd6-bfe8-136705227759',
                sleepImpl: async () => {},
                downloadImpl: () => {},
                fetchImpl: (async (input) => {
                    const url = String(input);
                    fetchedUrls.push(url);
                    if (url.includes('/rest/app-chat/conversations?pageSize=')) {
                        return new Response(
                            JSON.stringify({
                                conversations: [{ conversationId }],
                            }),
                            { status: 200 },
                        );
                    }
                    if (url.includes('/rest/app-chat/conversations_v2/')) {
                        return new Response('not found', { status: 404 });
                    }
                    if (url.includes('/rest/app-chat/conversations/') && url.includes('/response-node')) {
                        return new Response('not found', { status: 404 });
                    }
                    return new Response('not found', { status: 404 });
                }) as typeof fetch,
            },
        );

        expect(result.discovered).toBe(1);
        expect(result.exported).toBe(0);
        expect(fetchedUrls.some((url) => url.includes('/load-responses'))).toBeFalse();
    });
});
