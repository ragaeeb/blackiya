import { afterEach, beforeEach, describe, expect, it, type Mock, mock } from 'bun:test';
import { performSingleExport } from '@/features/single-export/single-export-service';
import type { SingleExportDeps, SingleExportResult } from '@/features/single-export/types';
import { SINGLE_EXPORT_DEFAULT_TIMEOUT_MS } from '@/features/single-export/types';
import { chatGPTAdapter } from '@/platforms/chatgpt';
import { geminiAdapter } from '@/platforms/gemini';
import { grokAdapter } from '@/platforms/grok';
import type { LLMPlatform } from '@/platforms/types';
import type { GeminiBatchexecuteContext } from '@/utils/gemini-batchexecute-context';
import type { ConversationData, Message, MessageNode } from '@/utils/types';
import { MAX_EXPLICIT_EXPORT_RESPONSE_BYTES } from '@/utils/bounded-response-body';

const CHATGPT_ID = '67f0a0b3-1234-4abc-8def-1234567890ab';
const GROK_ID = '01cb0729-6455-471d-b33a-124b3de76a29';
const X_GROK_ID = '2091428436845772921';
const GEMINI_ID = '20de061ec5dae81c';

const buildMessageNode = (id: string, parent: string | null, message: Message | null): MessageNode => ({
    id,
    parent,
    children: [],
    message,
});

const buildTerminalChatGptConversation = (id: string, opts: { title?: string } = {}): ConversationData => {
    const userMessage: Message = {
        id: 'user-msg',
        author: { role: 'user', name: null, metadata: {} },
        create_time: 1_700_000_000,
        update_time: null,
        content: { content_type: 'text', parts: ['Hello there'] },
        status: 'finished_successfully',
        end_turn: true,
        weight: 1,
        metadata: {},
        recipient: 'all',
        channel: null,
    };
    const assistantMessage: Message = {
        id: 'assistant-msg',
        author: { role: 'assistant', name: null, metadata: {} },
        create_time: 1_700_000_010,
        update_time: 1_700_000_020,
        content: { content_type: 'text', parts: ['Hi! How can I help?'] },
        status: 'finished_successfully',
        end_turn: true,
        weight: 1,
        metadata: {},
        recipient: 'all',
        channel: null,
    };
    const altAssistantMessage: Message = {
        id: 'alt-assistant-msg',
        author: { role: 'assistant', name: null, metadata: {} },
        create_time: 1_700_000_011,
        update_time: 1_700_000_021,
        content: { content_type: 'text', parts: ['Alternative branch response'] },
        status: 'finished_successfully',
        end_turn: true,
        weight: 0,
        metadata: {},
        recipient: 'all',
        channel: null,
    };
    const rootNode: MessageNode = {
        id: 'root',
        message: null,
        parent: null,
        children: ['user-node'],
    };
    const userNode = buildMessageNode('user-node', 'root', userMessage);
    const altAssistantNode = buildMessageNode('alt-assistant-node', 'user-node', altAssistantMessage);
    const assistantNode = buildMessageNode('assistant-node', 'user-node', assistantMessage);
    userNode.children = ['assistant-node', 'alt-assistant-node'];
    return {
        title: opts.title ?? 'Sample chat',
        create_time: 1_700_000_000,
        update_time: 1_700_000_020,
        mapping: {
            root: rootNode,
            'user-node': userNode,
            'assistant-node': assistantNode,
            'alt-assistant-node': altAssistantNode,
        },
        conversation_id: id,
        current_node: 'assistant-node',
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: 'gpt-4',
        safe_urls: [],
        blocked_urls: [],
    };
};

const buildInProgressChatGptConversation = (id: string): ConversationData => {
    const data = buildTerminalChatGptConversation(id);
    const assistantNode = data.mapping['assistant-node']!;
    // Keep the streamed text in place but flip status to in_progress so the
    // existing readiness evaluator reports `assistant-in-progress` (terminal: false).
    assistantNode.message = {
        ...assistantNode.message!,
        status: 'in_progress',
        content: { content_type: 'text', parts: ['partial response so far'] },
    };
    return data;
};

type TestContext = {
    deps: SingleExportDeps;
    fetchImpl: Mock<typeof fetch>;
    download: Mock<(jsonString: string, filename: string) => void>;
    logger: {
        info: Mock<(...args: unknown[]) => void>;
        warn: Mock<(...args: unknown[]) => void>;
        error: Mock<(...args: unknown[]) => void>;
        debug: Mock<(...args: unknown[]) => void>;
    };
    now: Mock<() => number>;
    setPageUrl: (url: string) => void;
    setAdapter: (adapter: LLMPlatform | null) => void;
    setAuthHeaders: (headers: Record<string, string> | undefined) => void;
    setGeminiContext: (ctx: GeminiBatchexecuteContext | undefined) => void;
    setFetchResponse: (init: {
        ok: boolean;
        status?: number;
        statusText?: string;
        text?: string;
        delayMs?: number;
    }) => void;
    setFetchError: (err: Error) => void;
    advanceTime: (ms: number) => void;
    abortSignals: AbortSignal[];
};

const createTestContext = (initial: { pageUrl: string; adapter: LLMPlatform | null }): TestContext => {
    let pageUrl = initial.pageUrl;
    let adapter: LLMPlatform | null = initial.adapter;
    let authHeaders: Record<string, string> | undefined = {
        authorization: 'Bearer test-token',
        'x-test': '1',
    };
    let geminiContext: GeminiBatchexecuteContext | undefined = {
        at: 'AT-TOKEN',
        bl: 'boq_test',
        fSid: 'fsid',
        hl: 'en',
        reqid: 100,
        rt: 'c',
        updatedAt: 1_700_000_000_000,
    };
    let now = 1_700_000_000_000;

    const abortSignals: AbortSignal[] = [];
    let nextResponse: { ok: boolean; status?: number; statusText?: string; text?: string; delayMs?: number } | null =
        null;
    let nextError: Error | null = null;

    const logger = {
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
    };

    const fetchImpl = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal) {
            abortSignals.push(init.signal);
        }
        if (nextError) {
            const err = nextError;
            nextError = null;
            throw err;
        }
        if (!nextResponse) {
            throw new Error('No mock response configured');
        }
        const resp = nextResponse;
        nextResponse = null;
        if (resp.delayMs) {
            const signal = init?.signal;
            await new Promise<void>((resolve, reject) => {
                let settled = false;
                const onAbort = () => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    reject(new DOMException('aborted', 'AbortError'));
                };
                if (signal) {
                    if (signal.aborted) {
                        onAbort();
                        return;
                    }
                    signal.addEventListener('abort', onAbort, { once: true });
                }
                const timerHandle = setTimeout(() => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    if (signal) {
                        signal.removeEventListener('abort', onAbort);
                    }
                    resolve();
                }, resp.delayMs);
                void timerHandle;
            });
        }
        return new Response(resp.text ?? '', {
            status: resp.status ?? 200,
            statusText: resp.statusText ?? 'OK',
        });
    }) as Mock<typeof fetch>;

    const download = mock((_jsonString: string, _filename: string) => {}) as TestContext['download'];

    const deps: SingleExportDeps = {
        resolveAdapter: (_url: string) => adapter,
        getPageUrl: () => pageUrl,
        getAuthHeaders: () => authHeaders,
        getGeminiBatchexecuteContext: () => geminiContext,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        downloadJson: download,
        now: () => now,
        logger,
    };

    return {
        deps,
        fetchImpl,
        download,
        logger,
        now: mock(() => now),
        setPageUrl: (url) => {
            pageUrl = url;
        },
        setAdapter: (next) => {
            adapter = next;
        },
        setAuthHeaders: (headers) => {
            authHeaders = headers;
        },
        setGeminiContext: (ctx) => {
            geminiContext = ctx;
        },
        setFetchResponse: (init) => {
            const { ok: _ok, ...rest } = init;
            void _ok;
            nextResponse = { ...rest, ok: init.ok };
        },
        setFetchError: (err) => {
            nextError = err;
        },
        advanceTime: (ms) => {
            now += ms;
        },
        abortSignals,
    };
};

describe('performSingleExport — resolution and validation', () => {
    it('should fail with unsupported_platform when no adapter matches the page URL', async () => {
        const testContext = createTestContext({ pageUrl: 'https://example.com/something', adapter: null });
        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);
        expect(result.kind).toBe('failure');
        if (result.kind !== 'failure') {
            return;
        }
        expect(result.error.kind).toBe('unsupported_platform');
    });

    it('should fail with missing_conversation_id when the URL has no conversation ID', async () => {
        const testContext = createTestContext({ pageUrl: 'https://chatgpt.com/', adapter: chatGPTAdapter });
        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);
        expect(result.kind).toBe('failure');
        if (result.kind !== 'failure') {
            return;
        }
        expect(result.error.kind).toBe('missing_conversation_id');
    });

    it('should fail with missing_endpoint when the adapter has no detail URL builder', async () => {
        const adapter = {
            ...chatGPTAdapter,
            buildApiUrl: undefined,
            buildApiUrls: undefined,
        } as unknown as LLMPlatform;
        const testContext = createTestContext({
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
            adapter,
        });
        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);
        expect(result.kind).toBe('failure');
        if (result.kind !== 'failure') {
            return;
        }
        expect(result.error.kind).toBe('missing_endpoint');
    });

    it('should reject an unsafe adapter candidate before reading or forwarding captured auth headers', async () => {
        const adapter = {
            ...chatGPTAdapter,
            detailRequestOrigins: ['https://chatgpt.com'],
            buildApiUrl: () => `https://example.com/conversations/${CHATGPT_ID}`,
            buildApiUrls: () => [`https://example.com/conversations/${CHATGPT_ID}`],
        };
        const testContext = createTestContext({
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
            adapter,
        });
        const getAuthHeaders = mock(() => ({ authorization: 'Bearer must-not-leak' }));
        testContext.deps.getAuthHeaders = getAuthHeaders;

        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);

        expect(result).toEqual({
            kind: 'failure',
            error: { kind: 'missing_endpoint', platformName: 'ChatGPT' },
        });
        expect(getAuthHeaders).not.toHaveBeenCalled();
        expect(testContext.fetchImpl).not.toHaveBeenCalled();
    });

    it('should fail with missing_auth for Gemini when the at token is unavailable', async () => {
        const testContext = createTestContext({
            pageUrl: `https://gemini.google.com/app/${GEMINI_ID}`,
            adapter: geminiAdapter,
        });
        testContext.setGeminiContext(undefined);
        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);
        expect(result.kind).toBe('failure');
        if (result.kind !== 'failure') {
            return;
        }
        expect(result.error.kind).toBe('missing_auth');
    });

    it('should fail with missing_auth before dispatch when ChatGPT authorization is unavailable', async () => {
        const testContext = createTestContext({
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
            adapter: chatGPTAdapter,
        });
        testContext.setAuthHeaders({ 'x-test': 'client-context-only' });
        testContext.setFetchResponse({ ok: true, status: 200, text: '{}' });

        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);

        expect(result).toEqual({
            kind: 'failure',
            error: { kind: 'missing_auth', platformName: 'ChatGPT' },
        });
        expect(testContext.fetchImpl).not.toHaveBeenCalled();
    });

    it('should accept an authorization header regardless of casing', async () => {
        const testContext = createTestContext({
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
            adapter: chatGPTAdapter,
        });
        const payload = buildTerminalChatGptConversation(CHATGPT_ID);
        testContext.setAuthHeaders({ Authorization: 'Bearer case-insensitive-token' });
        testContext.setFetchResponse({ ok: true, status: 200, text: JSON.stringify(payload) });

        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);

        expect(result.kind).toBe('success');
        expect(testContext.fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
            Authorization: 'Bearer case-insensitive-token',
        });
    });
});

describe('performSingleExport — HTTP/parse/ID/terminal', () => {
    let testContext: TestContext;
    beforeEach(() => {
        testContext = createTestContext({
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
            adapter: chatGPTAdapter,
        });
    });
    afterEach(() => {
        testContext.fetchImpl.mockReset();
        testContext.download.mockReset();
        testContext.logger.info.mockReset();
        testContext.logger.warn.mockReset();
        testContext.logger.error.mockReset();
        testContext.logger.debug.mockReset();
    });

    it('should fail with http_failure on a 5xx response', async () => {
        testContext.setFetchResponse({ ok: false, status: 503, statusText: 'Service Unavailable' });
        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);
        expect(result.kind).toBe('failure');
        if (result.kind !== 'failure') {
            return;
        }
        expect(result.error.kind).toBe('http_failure');
        if (result.error.kind === 'http_failure') {
            expect(result.error.status).toBe(503);
        }
    });

    it('should fail with missing_auth on a 401 response', async () => {
        const invalidateAuthContext = mock();
        testContext.deps.invalidateAuthContext = invalidateAuthContext;
        testContext.setFetchResponse({ ok: false, status: 401, statusText: 'Unauthorized' });
        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);
        expect(result.kind).toBe('failure');
        if (result.kind !== 'failure') {
            return;
        }
        expect(result.error.kind).toBe('missing_auth');
        expect(invalidateAuthContext).toHaveBeenCalledWith('ChatGPT');
    });

    it('should fail with missing_auth on a 403 response', async () => {
        const invalidateAuthContext = mock();
        testContext.deps.invalidateAuthContext = invalidateAuthContext;
        testContext.setFetchResponse({ ok: false, status: 403, statusText: 'Forbidden' });
        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);
        expect(result.kind).toBe('failure');
        if (result.kind !== 'failure') {
            return;
        }
        expect(result.error.kind).toBe('missing_auth');
        expect(invalidateAuthContext).toHaveBeenCalledWith('ChatGPT');
    });

    it('should invalidate Gemini context when a single export receives an auth failure', async () => {
        const geminiTestContext = createTestContext({
            pageUrl: `https://gemini.google.com/app/${GEMINI_ID}`,
            adapter: geminiAdapter,
        });
        const invalidateAuthContext = mock();
        geminiTestContext.deps.invalidateAuthContext = invalidateAuthContext;
        geminiTestContext.setFetchResponse({ ok: false, status: 403, statusText: 'Forbidden' });

        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, geminiTestContext.deps);

        expect(result).toMatchObject({ kind: 'failure', error: { kind: 'missing_auth' } });
        expect(invalidateAuthContext).toHaveBeenCalledWith('Gemini');
    });

    it('should fail with parse_failure when the parser returns null', async () => {
        testContext.setFetchResponse({ ok: true, status: 200, statusText: 'OK', text: 'unparseable' });
        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);
        expect(result.kind).toBe('failure');
        if (result.kind !== 'failure') {
            return;
        }
        expect(result.error.kind).toBe('parse_failure');
    });

    it('should return download_failure when browser download injection throws', async () => {
        const payload = buildTerminalChatGptConversation(CHATGPT_ID);
        testContext.setFetchResponse({ ok: true, status: 200, text: JSON.stringify(payload) });
        testContext.deps.downloadJson = () => {
            throw new Error('download permission denied');
        };

        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);

        expect(result).toEqual({
            kind: 'failure',
            error: {
                kind: 'download_failure',
                platformName: 'ChatGPT',
                reason: 'download permission denied',
            },
        });
    });

    it('should fail with id_mismatch when the response carries a different conversation_id', async () => {
        const wrong = buildTerminalChatGptConversation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
        testContext.setFetchResponse({ ok: true, status: 200, text: JSON.stringify(wrong) });
        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);
        expect(result.kind).toBe('failure');
        if (result.kind !== 'failure') {
            return;
        }
        expect(result.error.kind).toBe('id_mismatch');
        if (result.error.kind === 'id_mismatch') {
            expect(result.error.expected).toBe(CHATGPT_ID);
            expect(result.error.actual).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
        }
    });

    it('should fail with not_terminal when the conversation is still streaming', async () => {
        const inProgress = buildInProgressChatGptConversation(CHATGPT_ID);
        testContext.setFetchResponse({ ok: true, status: 200, text: JSON.stringify(inProgress) });
        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);
        expect(result.kind).toBe('failure');
        if (result.kind !== 'failure') {
            return;
        }
        expect(result.error.kind).toBe('not_terminal');
    });

    it('should fail with not_terminal when readiness is false even if terminal is true', async () => {
        const notReadyAdapter: LLMPlatform = {
            ...chatGPTAdapter,
            evaluateReadiness: () => ({
                ready: false,
                terminal: true,
                reason: 'assistant-text-missing',
                contentHash: null,
                latestAssistantTextLength: 0,
            }),
        };
        testContext = createTestContext({
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
            adapter: notReadyAdapter,
        });
        const payload = buildTerminalChatGptConversation(CHATGPT_ID);
        testContext.setFetchResponse({ ok: true, status: 200, text: JSON.stringify(payload) });

        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);
        expect(result.kind).toBe('failure');
        if (result.kind !== 'failure') {
            return;
        }
        expect(result.error.kind).toBe('not_terminal');
        if (result.error.kind === 'not_terminal') {
            expect(result.error.reason).toBe('assistant-text-missing');
        }
    });

    it('should fail with timeout when the AbortController fires after timeoutMs', async () => {
        // Mock delay > min-timeout so the AbortController actually fires before the response resolves.
        testContext.setFetchResponse({ ok: true, status: 200, text: '{}', delayMs: 2000 });
        const result = await performSingleExport(100, testContext.deps);
        if (result.kind !== 'failure') {
            throw new Error(`expected failure but got ${result.kind}`);
        }
        expect(result.error.kind).toBe('timeout');
    });
});

describe('performSingleExport — successful terminal exports', () => {
    it('should save a terminal cached response without auth, endpoint resolution, or another fetch', async () => {
        const payload = buildTerminalChatGptConversation(CHATGPT_ID, { title: 'Cached export' });
        const cacheOnlyAdapter: LLMPlatform = {
            ...chatGPTAdapter,
            buildApiUrl: undefined,
            buildApiUrls: undefined,
        };
        const testContext = createTestContext({
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
            adapter: cacheOnlyAdapter,
        });
        testContext.setAuthHeaders(undefined);
        testContext.deps.getCachedConversation = (platformName, conversationId) =>
            platformName === 'ChatGPT' && conversationId === CHATGPT_ID ? payload : undefined;

        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);

        expect(result.kind).toBe('success');
        expect(testContext.fetchImpl).not.toHaveBeenCalled();
        expect(testContext.download).toHaveBeenCalledTimes(1);
    });

    it('should save a cached response for a generic cache-only adapter', async () => {
        const payload = buildTerminalChatGptConversation(CHATGPT_ID, { title: 'Cache-only provider export' });
        const cacheOnlyAdapter: LLMPlatform = {
            name: 'Cache-only',
            urlMatchPattern: 'https://cache.example/*',
            isPlatformUrl: (url) => url.startsWith('https://cache.example/'),
            extractConversationId: () => CHATGPT_ID,
            parseInterceptedData: () => null,
            formatFilename: () => 'cache-only-export',
            evaluateReadiness: () => ({
                ready: true,
                terminal: true,
                reason: 'terminal',
                contentHash: null,
                latestAssistantTextLength: 1,
            }),
        };
        const testContext = createTestContext({
            pageUrl: `https://cache.example/c/${CHATGPT_ID}`,
            adapter: cacheOnlyAdapter,
        });
        testContext.deps.getCachedConversation = () => payload;

        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);

        expect(result).toMatchObject({ kind: 'success', platformName: 'Cache-only' });
        expect(testContext.fetchImpl).not.toHaveBeenCalled();
        expect(testContext.download).toHaveBeenCalledWith(expect.any(String), 'cache-only-export.json');
    });

    it('should preserve an existing JSON suffix when delivering the actual download', async () => {
        const payload = buildTerminalChatGptConversation(CHATGPT_ID);
        const adapter: LLMPlatform = {
            ...chatGPTAdapter,
            formatFilename: () => 'already-json.json',
        };
        const testContext = createTestContext({
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
            adapter,
        });
        testContext.deps.getCachedConversation = () => payload;

        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);

        expect(result).toMatchObject({ kind: 'success', filename: 'already-json.json' });
        expect(testContext.download).toHaveBeenCalledWith(expect.any(String), 'already-json.json');
    });

    it('should use the next deterministic ChatGPT endpoint after a 404', async () => {
        const payload = buildTerminalChatGptConversation(CHATGPT_ID);
        const urls: string[] = [];
        const responses = [
            new Response('', { status: 404, statusText: 'Not Found' }),
            new Response(JSON.stringify(payload), { status: 200, statusText: 'OK' }),
        ];
        const testContext = createTestContext({
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
            adapter: chatGPTAdapter,
        });
        const fetchImpl = mock(async (input: RequestInfo | URL) => {
            urls.push(String(input));
            const response = responses.shift();
            if (!response) {
                throw new Error('unexpected request');
            }
            return response;
        });
        testContext.deps.fetchImpl = fetchImpl as unknown as typeof fetch;

        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);

        expect(result.kind).toBe('success');
        expect(urls).toEqual([
            `https://chatgpt.com/backend-api/conversation/${CHATGPT_ID}`,
            `https://chatgpt.com/backend-api/f/conversation/${CHATGPT_ID}`,
        ]);
    });

    it('should export the sanitized HAR-derived x.com Grok detail response', async () => {
        const testContext = createTestContext({
            pageUrl: `https://x.com/i/grok?conversation=${X_GROK_ID}`,
            adapter: grokAdapter,
        });
        testContext.setAuthHeaders({
            'x-csrf-token': 'synthetic-csrf',
            'x-twitter-active-user': 'yes',
            'x-twitter-auth-type': 'OAuth2Session',
        });
        testContext.setFetchResponse({
            ok: true,
            status: 200,
            text: JSON.stringify({
                data: {
                    grok_conversation_by_rest_id: { is_pinned: false },
                    grok_conversation_items_by_rest_id: {
                        cursor: 'synthetic',
                        items: [
                            {
                                chat_item_id: '2091428438666096641',
                                created_at_ms: 1_787_470_371_309,
                                grok_mode: 'Normal',
                                is_partial: false,
                                message: 'Terminal synthetic answer.',
                                sender_type: 'Agent',
                            },
                            {
                                chat_item_id: '2091428438666096640',
                                created_at_ms: 1_787_470_370_000,
                                grok_mode: 'Normal',
                                message: 'Synthetic question?',
                                sender_type: 'User',
                            },
                        ],
                    },
                },
            }),
        });

        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);

        expect(result.kind).toBe('success');
        if (result.kind !== 'success') {
            return;
        }
        expect(result.data.conversation_id).toBe(X_GROK_ID);
        expect(result.data.mapping['2091428438666096641']?.message?.status).toBe('finished_successfully');
        expect(testContext.fetchImpl.mock.calls[0]?.[0]).toContain('/GrokConversationItemsByRestId?');
    });

    const cases = [
        {
            name: 'ChatGPT',
            id: CHATGPT_ID,
            adapter: chatGPTAdapter,
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
            buildPayload: (id: string) => buildTerminalChatGptConversation(id, { title: 'ChatGPT export test' }),
        },
        {
            name: 'Grok',
            id: GROK_ID,
            adapter: grokAdapter,
            pageUrl: `https://grok.com/c/${GROK_ID}`,
            buildPayload: (id: string) => {
                const base = buildTerminalChatGptConversation(id, { title: 'Grok export test' });
                return { ...base, default_model_slug: 'grok-2' };
            },
        },
        {
            name: 'Gemini',
            id: GEMINI_ID,
            adapter: geminiAdapter,
            pageUrl: `https://gemini.google.com/app/${GEMINI_ID}`,
            buildPayload: (id: string) => buildTerminalChatGptConversation(id, { title: 'Gemini export test' }),
        },
    ] as const;

    for (const c of cases) {
        it(`should produce a successful terminal export for ${c.name}`, async () => {
            const payload = c.buildPayload(c.id);
            // For the kernel contract, the parser is part of the adapter, not the
            // kernel under test. Stub the parser on a fresh adapter copy so the
            // platform-specific fixtures don't dominate these kernel-flow tests.
            const stubbedAdapter: LLMPlatform = {
                ...c.adapter,
                parseInterceptedData: (_data: string, _url: string) => payload,
                evaluateReadiness: () => ({
                    ready: true,
                    terminal: true,
                    reason: 'kernel-stub',
                    contentHash: 'kernel-stub',
                    latestAssistantTextLength: 1,
                }),
                formatFilename: (data: ConversationData) => `${c.name}_export_test_${data.conversation_id.slice(0, 8)}`,
            };
            const testContext = createTestContext({ pageUrl: c.pageUrl, adapter: stubbedAdapter });
            testContext.setFetchResponse({ ok: true, status: 200, text: JSON.stringify(payload) });

            const result: SingleExportResult = await performSingleExport(
                SINGLE_EXPORT_DEFAULT_TIMEOUT_MS,
                testContext.deps,
            );

            if (result.kind !== 'success') {
                throw new Error(
                    `expected success for ${c.name}, got ${result.error.kind}: ${JSON.stringify(result.error)}`,
                );
            }
            expect(result.kind).toBe('success');
            // Title and filename handling
            expect(result.data.title).toBe(payload.title);
            expect(result.filename).toBe(`${c.name}_export_test_${c.id.slice(0, 8)}.json`);
            expect(result.jsonString).toBe(JSON.stringify(payload, null, 2));
            // Download was invoked with the serialized JSON and the filename
            expect(testContext.download).toHaveBeenCalledTimes(1);
            const call = testContext.download.mock.calls[0]!;
            expect(call[0]).toBe(result.jsonString);
            expect(call[1]).toBe(result.filename);
        });

        it(`should preserve the complete conversation tree for ${c.name}`, async () => {
            const payload = c.buildPayload(c.id);
            const stubbedAdapter: LLMPlatform = {
                ...c.adapter,
                parseInterceptedData: (_data: string, _url: string) => payload,
                evaluateReadiness: () => ({
                    ready: true,
                    terminal: true,
                    reason: 'kernel-stub',
                    contentHash: 'kernel-stub',
                    latestAssistantTextLength: 1,
                }),
            };
            const testContext = createTestContext({ pageUrl: c.pageUrl, adapter: stubbedAdapter });
            testContext.setFetchResponse({ ok: true, status: 200, text: JSON.stringify(payload) });

            const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);
            expect(result.kind).toBe('success');
            if (result.kind !== 'success') {
                return;
            }

            // The full mapping must be retained, including alternate branches and the root.
            const mappingKeys = Object.keys(result.data.mapping).sort();
            expect(mappingKeys).toEqual(['alt-assistant-node', 'assistant-node', 'root', 'user-node']);
            expect(result.data.mapping['user-node']?.children).toEqual(
                expect.arrayContaining(['assistant-node', 'alt-assistant-node']),
            );
            expect(result.data.conversation_id).toBe(c.id);
            expect(result.data.current_node).toBe('assistant-node');
        });
    }

    it('should sanitize placeholder/empty titles through the adapter formatter', async () => {
        const testContext = createTestContext({
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
            adapter: chatGPTAdapter,
        });
        const payload = buildTerminalChatGptConversation(CHATGPT_ID, { title: 'New conversation' });
        testContext.setFetchResponse({ ok: true, status: 200, text: JSON.stringify(payload) });

        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') {
            return;
        }
        // Adapter's formatFilename derives a title from the first user message
        // when the title is a placeholder.
        expect(
            result.filename.startsWith('Hello_there_') || result.filename.startsWith('New_conversation_'),
        ).toBeTrue();
    });
});

describe('performSingleExport — request shape', () => {
    it('should fail with a typed oversized-response error before reading a declared oversized body', async () => {
        const testContext = createTestContext({
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
            adapter: chatGPTAdapter,
        });
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel: () => {
                cancelled = true;
            },
        });
        testContext.deps.fetchImpl = mock(
            async () =>
                new Response(body, {
                    status: 200,
                    headers: { 'content-length': String(MAX_EXPLICIT_EXPORT_RESPONSE_BYTES + 1) },
                }),
        ) as unknown as typeof fetch;

        const result = await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);

        expect(result).toEqual({
            kind: 'failure',
            error: {
                kind: 'response_too_large',
                platformName: 'ChatGPT',
                maxBytes: MAX_EXPLICIT_EXPORT_RESPONSE_BYTES,
            },
        });
        expect(cancelled).toBeTrue();
        expect(testContext.download).not.toHaveBeenCalled();
    });

    it('should time out when the response body never resolves', async () => {
        const testContext = createTestContext({
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
            adapter: chatGPTAdapter,
        });
        const stalledResponse = {
            ok: true,
            status: 200,
            statusText: 'OK',
            text: () => new Promise<string>(() => {}),
        } as unknown as Response;
        testContext.deps.fetchImpl = mock(async () => stalledResponse) as unknown as typeof fetch;

        const result = await performSingleExport(100, testContext.deps);

        expect(result).toEqual({
            kind: 'failure',
            error: {
                kind: 'timeout',
                platformName: 'ChatGPT',
                timeoutMs: 1000,
            },
        });
    });

    it('should pass credentials: include and the auth headers for ChatGPT', async () => {
        const testContext = createTestContext({
            pageUrl: `https://chatgpt.com/c/${CHATGPT_ID}`,
            adapter: chatGPTAdapter,
        });
        const payload = buildTerminalChatGptConversation(CHATGPT_ID);
        testContext.setFetchResponse({ ok: true, status: 200, text: JSON.stringify(payload) });

        await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);

        expect(testContext.fetchImpl).toHaveBeenCalledTimes(1);
        const init = testContext.fetchImpl.mock.calls[0]![1];
        expect(init?.credentials).toBe('include');
        expect(init?.headers).toEqual({ authorization: 'Bearer test-token', 'x-test': '1' });
    });

    it('should POST the Gemini batchexecute body with content-type', async () => {
        const testContext = createTestContext({
            pageUrl: `https://gemini.google.com/app/${GEMINI_ID}`,
            adapter: geminiAdapter,
        });
        const payload = buildTerminalChatGptConversation(GEMINI_ID);
        testContext.setFetchResponse({ ok: true, status: 200, text: JSON.stringify(payload) });

        await performSingleExport(SINGLE_EXPORT_DEFAULT_TIMEOUT_MS, testContext.deps);

        expect(testContext.fetchImpl).toHaveBeenCalledTimes(1);
        const call = testContext.fetchImpl.mock.calls[0]!;
        const url = call[0];
        const init = call[1];
        if (!init) {
            throw new Error('expected init');
        }
        expect(init.method).toBe('POST');
        expect(typeof init.body).toBe('string');
        const headers = (init.headers ?? {}) as Record<string, string>;
        expect(headers['content-type']).toBe('application/x-www-form-urlencoded;charset=UTF-8');
        expect(url as string).toContain('rpcids=hNvQHb');
    });
});
