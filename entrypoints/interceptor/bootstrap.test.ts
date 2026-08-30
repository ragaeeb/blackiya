import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import {
    default as bootstrapScript,
    captureFetchRequestContext,
    invalidateCapturedRequestContext,
    isGeminiBatchexecutePost,
} from '@/entrypoints/interceptor/bootstrap';
import {
    getGeminiBatchexecuteContext,
    resetGeminiBatchexecuteContext,
} from '@/entrypoints/interceptor/gemini-batchexecute-context-store';
import { conversationResponseCache } from '@/features/single-export/conversation-response-cache';
import { streamDebugRecorder } from '@/features/stream-debug/recorder';
import {
    SYNTHETIC_CONVERSATION_ID as CLAUDE_CONVERSATION_ID,
    CLAUDE_DETAIL_URL,
} from '@/platforms/claude/fixtures/conversation';
import {
    createCurrentDeepSeekHistoryResponse,
    SYNTHETIC_DEEPSEEK_CONVERSATION_ID,
    SYNTHETIC_DEEPSEEK_FULL_HISTORY_URL,
    SYNTHETIC_DEEPSEEK_HISTORY_URL,
} from '@/platforms/deepseek/fixtures/history-response';
import { buildXGrokConversationItemsUrl } from '@/platforms/grok/x-url-utils';
import {
    createMetaDetailFixture,
    createMetaOlderPageFixture,
    SYNTHETIC_META_CONVERSATION_ID,
} from '@/platforms/meta/fixtures/conversation';
import { buildMetaConversationDetailRequest, buildMetaConversationPaginationRequest } from '@/platforms/meta/request';
import { NOVA_CONVERSATION_DETAIL_TARGET } from '@/platforms/nova/constants';
import {
    createNovaConversationFixture,
    NOVA_CONVERSATION_ID,
    terminalNovaConversation,
} from '@/platforms/nova/fixtures/conversation';
import {
    ZAI_ASSISTANT_MESSAGE_ID,
    ZAI_CONVERSATION_ID,
    zaiDetailPayloadFixture,
    zaiMessagesBatchPayloadFixture,
} from '@/platforms/zai/fixtures/har-derived';
import { buildZaiMessagesBatchRequest } from '@/platforms/zai/requests';
import { platformHeaderStore } from '@/utils/platform-header-store';
import type { ConversationData } from '@/utils/types';

const waitForCapture = () => new Promise((resolve) => setTimeout(resolve, 0));

const createTerminalChatGptPayload = (conversationId: string, title = 'Observed response'): ConversationData => ({
    title,
    create_time: 1,
    update_time: 2,
    mapping: {
        root: { id: 'root', message: null, parent: null, children: ['assistant'] },
        assistant: {
            id: 'assistant',
            parent: 'root',
            children: [],
            message: {
                id: 'assistant-message',
                author: { role: 'assistant', name: null, metadata: {} },
                create_time: 1,
                update_time: 2,
                content: { content_type: 'text', parts: ['Terminal answer'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        },
    },
    conversation_id: conversationId,
    current_node: 'assistant',
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'gpt-test',
    safe_urls: [],
    blocked_urls: [],
});

const X_GROK_CONVERSATION_ID = '2091428436845772921';
const createXGrokPayload = (message: string, isPartial = false) => ({
    data: {
        grok_conversation_by_rest_id: { is_pinned: false },
        grok_conversation_items_by_rest_id: {
            cursor: 'synthetic-cursor',
            items: [
                {
                    chat_item_id: '2091428438666096641',
                    created_at_ms: 1_787_470_371_309,
                    grok_mode: 'Normal',
                    is_partial: isPartial,
                    message,
                    sender_type: 'Agent',
                },
                {
                    chat_item_id: '2091428438666096640',
                    created_at_ms: 1_787_470_370_000,
                    grok_mode: 'Normal',
                    message: 'A synthetic question?',
                    sender_type: 'User',
                },
            ],
        },
    },
});

const installDeferredXhrTransport = (windowInstance: Window) => {
    const pending: InstanceType<typeof windowInstance.XMLHttpRequest>[] = [];
    windowInstance.XMLHttpRequest.prototype.send = function () {
        pending.push(this);
    };
    const respond = (xhr: InstanceType<typeof windowInstance.XMLHttpRequest>, responseText: string, status = 200) => {
        Object.defineProperty(xhr, 'status', { configurable: true, value: status });
        Object.defineProperty(xhr, 'responseText', { configurable: true, value: responseText });
        xhr.dispatchEvent(new windowInstance.Event('load'));
    };
    return { pending, respond };
};

const createDeferredBodyClone = (text: string) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    const cancel = mock(async () => undefined);
    const bytes = new TextEncoder().encode(text);
    let emitted = false;
    const clone = {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
            getReader: () => ({
                read: async () => {
                    if (emitted) {
                        return { done: true as const, value: undefined };
                    }
                    await released;
                    emitted = true;
                    return { done: false as const, value: bytes };
                },
                cancel,
            }),
        },
        text: async () => {
            await released;
            return text;
        },
    } as unknown as Response;
    return { cancel, clone, release };
};

const createImmediateBodyClone = (text: string) => {
    const cancel = mock(async () => undefined);
    const bytes = new TextEncoder().encode(text);
    let emitted = false;
    const clone = {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
            getReader: () => ({
                read: async () => {
                    if (emitted) {
                        return { done: true as const, value: undefined };
                    }
                    emitted = true;
                    return { done: false as const, value: bytes };
                },
                cancel,
            }),
        },
        text: async () => text,
    } as unknown as Response;
    return { cancel, clone };
};

const withCaptureByteLimit = async (maxBytes: number, action: () => Promise<void>) => {
    const original = conversationResponseCache.getMaxBytesPerEntry;
    conversationResponseCache.getMaxBytesPerEntry = () => maxBytes;
    try {
        await action();
    } finally {
        conversationResponseCache.getMaxBytesPerEntry = original;
    }
};

describe('MAIN-world bootstrap request capture', () => {
    let originalClone: typeof Request.prototype.clone;
    let originalWindow: PropertyDescriptor | undefined;

    beforeEach(() => {
        originalClone = Request.prototype.clone;
        originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        platformHeaderStore.clear();
        resetGeminiBatchexecuteContext();
        streamDebugRecorder.clear();
        conversationResponseCache.clear();
    });

    afterEach(() => {
        Request.prototype.clone = originalClone;
        if (originalWindow) {
            Object.defineProperty(globalThis, 'window', originalWindow);
        } else {
            delete (globalThis as Record<string, unknown>).window;
        }
        platformHeaderStore.clear();
        resetGeminiBatchexecuteContext();
        streamDebugRecorder.clear();
        conversationResponseCache.clear();
    });

    it('recognizes only Gemini batchexecute POST requests for body capture', () => {
        expect(
            isGeminiBatchexecutePost('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb', 'POST'),
        ).toBeTrue();
        expect(
            isGeminiBatchexecutePost('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb', 'GET'),
        ).toBeFalse();
        expect(isGeminiBatchexecutePost('https://chatgpt.com/_/BardChatUi/data/batchexecute', 'POST')).toBeFalse();
    });

    it('recognizes absolute Gemini URLs when the ambient window has no location', () => {
        const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        try {
            Object.defineProperty(globalThis, 'window', {
                configurable: true,
                value: globalThis,
                writable: true,
            });

            expect(
                isGeminiBatchexecutePost(
                    'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb',
                    'POST',
                ),
            ).toBeTrue();
        } finally {
            if (originalWindow) {
                Object.defineProperty(globalThis, 'window', originalWindow);
            } else {
                delete (globalThis as Record<string, unknown>).window;
            }
        }
    });

    it('does not clone or read an unrelated large POST body before forwarding', async () => {
        const requestBody = 'x'.repeat(100_000);
        const request = new Request('https://chatgpt.com/backend-api/generate', {
            method: 'POST',
            body: requestBody,
        });
        let cloneCalls = 0;
        Request.prototype.clone = function () {
            cloneCalls += 1;
            return originalClone.call(this);
        };

        await captureFetchRequestContext([request], request.url, 'POST');

        expect(cloneCalls).toBe(0);
        expect(getGeminiBatchexecuteContext()).toBeUndefined();
    });

    it('clones only the Gemini batchexecute request body and leaves the page body readable', async () => {
        const requestBody = 'f.req=%5B%5B%5B%5D%5D%5D&at=AJvToken%3A1&';
        const request = new Request(
            'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&bl=boq&f.sid=123&hl=en&_reqid=42&rt=c',
            {
                method: 'POST',
                body: requestBody,
            },
        );
        let cloneCalls = 0;
        Request.prototype.clone = function () {
            cloneCalls += 1;
            return originalClone.call(this);
        };

        await captureFetchRequestContext([request], request.url, 'POST');

        expect(cloneCalls).toBe(1);
        expect(await request.text()).toBe(requestBody);
        expect(getGeminiBatchexecuteContext()?.at).toBe('AJvToken:1');
    });

    it('should cancel an oversized Gemini request clone before context parsing', async () => {
        const request = new Request(
            'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&bl=boq&f.sid=123&hl=en&_reqid=42&rt=c',
            { method: 'POST', body: 'f.req=x&at=secret' },
        );
        const oversized = createImmediateBodyClone('f.req=x&at=secret');
        request.clone = () => oversized.clone as unknown as Request;

        await withCaptureByteLimit(8, async () => {
            await captureFetchRequestContext([request], request.url, 'POST');
        });

        expect(oversized.cancel).toHaveBeenCalledTimes(1);
        expect(getGeminiBatchexecuteContext()).toBeUndefined();
        expect(await request.text()).toBe('f.req=x&at=secret');
    });

    it('installs the fetch interceptor without consuming the original streamed response', async () => {
        const windowInstance = new Window();
        const responseBody = 'data: streamed response\n\n';
        windowInstance.fetch = async () => new windowInstance.Response(responseBody);
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();

        const response = await windowInstance.fetch('https://chatgpt.com/backend-api/f/conversation', {
            method: 'POST',
            headers: {
                authorization: 'Bearer chatgpt-token',
                'oai-client-version': 'client-version',
                'x-api-key': 'blocked-api-key',
                'x-csrf-token': 'blocked-csrf-token',
                'x-request-signature': 'blocked-signature',
                'x-custom-header': 'blocked-custom-header',
            },
        });

        expect(await response.text()).toBe(responseBody);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(streamDebugRecorder.exportRecords()[0]?.status).toBe('closed');
        expect(platformHeaderStore.get('ChatGPT')).toEqual({
            authorization: 'Bearer chatgpt-token',
            'oai-client-version': 'client-version',
        });
    });

    it('should monitor a generation response without cloning or consuming ahead of the page', async () => {
        const windowInstance = new Window({ url: 'https://chatgpt.com/c/synthetic' });
        let cloneCalls = 0;
        windowInstance.fetch = async () => {
            const response = new windowInstance.Response('data: refusal\n\ndata: [DONE]\n\n', {
                status: 202,
                statusText: 'Accepted',
                headers: { 'content-type': 'text/event-stream', 'x-synthetic': 'preserved' },
            });
            response.clone = () => {
                cloneCalls += 1;
                throw new Error('generation response must not be cloned');
            };
            return response;
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        const response = await windowInstance.fetch('https://chatgpt.com/backend-api/f/conversation', {
            method: 'POST',
        });

        expect(cloneCalls).toBe(0);
        expect(response.status).toBe(202);
        expect(response.statusText).toBe('Accepted');
        expect(response.headers.get('x-synthetic')).toBe('preserved');
        expect(streamDebugRecorder.exportRecords()[0]?.frames).toEqual([]);

        expect(await response.text()).toBe('data: refusal\n\ndata: [DONE]\n\n');
        expect(cloneCalls).toBe(0);
        expect(streamDebugRecorder.exportRecords()[0]?.frames.map((frame) => frame.kind)).toEqual([
            'refusal',
            'done',
            'transport',
        ]);
        expect(streamDebugRecorder.exportRecords()[0]?.status).toBe('closed');
    });

    it('does not retry a rejected non-idempotent POST after the page fetch was invoked', async () => {
        const windowInstance = new Window();
        const rejection = new Error('generation request failed after forwarding');
        let originalFetchCalls = 0;
        windowInstance.fetch = async () => {
            originalFetchCalls += 1;
            throw rejection;
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();

        await expect(
            windowInstance.fetch('https://chatgpt.com/backend-api/f/conversation', {
                method: 'POST',
                body: JSON.stringify({ prompt: 'non-idempotent request' }),
            }),
        ).rejects.toBe(rejection);
        expect(originalFetchCalls).toBe(1);
    });

    it('should not clone a page response outside every conversation-detail allowlist', async () => {
        let cloneCalls = 0;
        const windowInstance = new Window({ url: 'https://chatgpt.com/' });
        windowInstance.fetch = async () => {
            const response = new windowInstance.Response(JSON.stringify({ unrelated: true }));
            const clone = response.clone.bind(response);
            response.clone = () => {
                cloneCalls += 1;
                return clone();
            };
            return response;
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        const response = await windowInstance.fetch('https://chatgpt.com/backend-api/conversations');

        expect(await response.text()).toBe(JSON.stringify({ unrelated: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(cloneCalls).toBe(0);
    });

    it('captures Qwen completion responses with SSE framing', async () => {
        const conversationId = '67f0a0b3-1234-4abc-8def-1234567890ab';
        const windowInstance = new Window({ url: `https://chat.qwen.ai/c/${conversationId}` });
        windowInstance.fetch = async () => new windowInstance.Response('data: {"synthetic":true}\n\ndata: [DONE]\n\n');
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        const response = await windowInstance.fetch(
            `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${conversationId}`,
            { method: 'POST' },
        );

        expect(await response.text()).toContain('[DONE]');
        await new Promise((resolve) => setTimeout(resolve, 0));
        const record = streamDebugRecorder.exportRecords()[0];
        expect(record?.platform).toBe('Qwen');
        expect(record?.frames.some((frame) => frame.kind === 'done')).toBeTrue();
    });

    it('caches a terminal conversation detail response without consuming the page response', async () => {
        const conversationId = '67f0a0b3-1234-4abc-8def-1234567890ab';
        const payload = createTerminalChatGptPayload(conversationId);
        const windowInstance = new Window({ url: `https://chatgpt.com/c/${conversationId}` });
        windowInstance.fetch = async () => new windowInstance.Response(JSON.stringify(payload));
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        const response = await windowInstance.fetch(`https://chatgpt.com/backend-api/conversation/${conversationId}`, {
            headers: { authorization: 'Bearer first-observed-account' },
        });

        expect(await response.text()).toBe(JSON.stringify(payload));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(conversationResponseCache.get('ChatGPT', conversationId)?.title).toBe('Observed response');
    });

    it('should invalidate only the matching cached conversation when exact-provider generation begins', async () => {
        const conversationId = '67f0a0b3-1234-4abc-8def-1234567890ab';
        const payload = createTerminalChatGptPayload(conversationId);
        conversationResponseCache.set('ChatGPT', payload);
        const windowInstance = new Window({ url: `https://chatgpt.com/c/${conversationId}` });
        windowInstance.fetch = async () => new windowInstance.Response('data: synthetic\n\n');
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' });

        expect(conversationResponseCache.get('ChatGPT', conversationId)).toBeUndefined();
    });

    it('should invalidate the active snapshot when an exact-provider generation request uses a relative URL', async () => {
        const conversationId = '67f0a0b3-1234-4abc-8def-1234567890ab';
        conversationResponseCache.set('ChatGPT', createTerminalChatGptPayload(conversationId));
        const windowInstance = new Window({ url: `https://chatgpt.com/c/${conversationId}` });
        windowInstance.fetch = async () => new windowInstance.Response('data: synthetic\n\n');
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch('/backend-api/f/conversation', { method: 'POST' });

        expect(conversationResponseCache.get('ChatGPT', conversationId)).toBeUndefined();
    });

    it('should not invalidate a cached conversation for a generation-shaped request on another origin', async () => {
        const conversationId = '67f0a0b3-1234-4abc-8def-1234567890ab';
        const payload = createTerminalChatGptPayload(conversationId);
        conversationResponseCache.set('ChatGPT', payload);
        const windowInstance = new Window({ url: `https://chatgpt.com/c/${conversationId}` });
        windowInstance.fetch = async () => new windowInstance.Response('data: synthetic\n\n');
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch('https://example.test/backend-api/f/conversation', { method: 'POST' });

        expect(conversationResponseCache.get('ChatGPT', conversationId)).toBeDefined();
    });

    it('should reject a delayed generic capture after provider auth invalidation', async () => {
        const conversationId = '67f0a0b3-1234-4abc-8def-1234567890ab';
        const payloadText = JSON.stringify(createTerminalChatGptPayload(conversationId));
        const delayed = createDeferredBodyClone(payloadText);
        const windowInstance = new Window({ url: `https://chatgpt.com/c/${conversationId}` });
        windowInstance.fetch = async () => {
            const response = new windowInstance.Response(payloadText);
            response.clone = () => delayed.clone as unknown as InstanceType<typeof windowInstance.Response>;
            return response;
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        const pageResponse = await windowInstance.fetch(
            `https://chatgpt.com/backend-api/conversation/${conversationId}`,
        );
        expect(invalidateCapturedRequestContext('https://chatgpt.com/backend-api/conversations', 401)).toBeTrue();
        delayed.release();
        await waitForCapture();

        expect(conversationResponseCache.get('ChatGPT', conversationId)).toBeUndefined();
        expect(await pageResponse.text()).toBe(payloadText);
    });

    it('should not let an older delayed terminal detail repopulate after a newer non-terminal detail', async () => {
        const conversationId = '67f0a0b3-1234-4abc-8def-1234567890ab';
        const terminal = createTerminalChatGptPayload(conversationId, 'Superseded terminal snapshot');
        const nonTerminal = structuredClone(terminal);
        const assistant = nonTerminal.mapping.assistant?.message;
        if (!assistant) {
            throw new Error('expected synthetic assistant');
        }
        assistant.status = 'in_progress';
        assistant.end_turn = false;
        const terminalText = JSON.stringify(terminal);
        const delayed = createDeferredBodyClone(terminalText);
        let responseIndex = 0;
        const windowInstance = new Window({ url: `https://chatgpt.com/c/${conversationId}` });
        windowInstance.fetch = async () => {
            const isDelayed = responseIndex++ === 0;
            const response = new windowInstance.Response(isDelayed ? terminalText : JSON.stringify(nonTerminal));
            if (isDelayed) {
                response.clone = () => delayed.clone as unknown as InstanceType<typeof windowInstance.Response>;
            }
            return response;
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });
        conversationResponseCache.set('ChatGPT', terminal);

        (bootstrapScript as { main: () => void }).main();
        const detailUrl = `https://chatgpt.com/backend-api/conversation/${conversationId}`;
        await windowInstance.fetch(detailUrl);
        await windowInstance.fetch(detailUrl);
        await waitForCapture();
        expect(conversationResponseCache.get('ChatGPT', conversationId)).toBeUndefined();

        delayed.release();
        await waitForCapture();

        expect(conversationResponseCache.get('ChatGPT', conversationId)).toBeUndefined();
    });

    it('should not let an older delayed plural ChatGPT detail replace a newer terminal detail', async () => {
        const conversationId = '67f0a0b3-1234-4abc-8def-1234567890ab';
        const olderText = JSON.stringify(createTerminalChatGptPayload(conversationId, 'Older snapshot'));
        const newerText = JSON.stringify(createTerminalChatGptPayload(conversationId, 'Newer snapshot'));
        const delayed = createDeferredBodyClone(olderText);
        let responseIndex = 0;
        const windowInstance = new Window({ url: `https://chatgpt.com/c/${conversationId}` });
        windowInstance.fetch = async () => {
            const isOlder = responseIndex++ === 0;
            const response = new windowInstance.Response(isOlder ? olderText : newerText);
            if (isOlder) {
                response.clone = () => delayed.clone as unknown as InstanceType<typeof windowInstance.Response>;
            }
            return response;
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        const detailUrl = `https://chatgpt.com/backend-api/conversations/${conversationId}?include_has_versions=true&num_turns=10`;
        await windowInstance.fetch(detailUrl);
        await windowInstance.fetch(detailUrl);
        await waitForCapture();
        expect(conversationResponseCache.get('ChatGPT', conversationId)?.title).toBe('Newer snapshot');

        delayed.release();
        await waitForCapture();
        expect(conversationResponseCache.get('ChatGPT', conversationId)?.title).toBe('Newer snapshot');
    });

    it('should invalidate a cache-only snapshot when a canonical detail request exposes its conversation id', async () => {
        conversationResponseCache.set(
            'Claude',
            createTerminalChatGptPayload(CLAUDE_CONVERSATION_ID, 'Superseded Claude snapshot'),
        );
        const windowInstance = new Window({ url: `https://claude.ai/chat/${CLAUDE_CONVERSATION_ID}` });
        windowInstance.fetch = async () => new windowInstance.Response('{}');
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch(CLAUDE_DETAIL_URL);
        await waitForCapture();

        expect(conversationResponseCache.get('Claude', CLAUDE_CONVERSATION_ID)).toBeUndefined();
    });

    it('should invalidate a snapshot when a deterministic detail request uses a relative URL', async () => {
        const conversationId = '67f0a0b3-1234-4abc-8def-1234567890ab';
        conversationResponseCache.set('ChatGPT', createTerminalChatGptPayload(conversationId));
        const windowInstance = new Window({ url: `https://chatgpt.com/c/${conversationId}` });
        windowInstance.fetch = async () => new windowInstance.Response('{}');
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch(`/backend-api/conversation/${conversationId}`);
        await waitForCapture();

        expect(conversationResponseCache.get('ChatGPT', conversationId)).toBeUndefined();
    });

    it('caches only the targeted Amazon Nova conversation RPC response', async () => {
        const windowInstance = new Window({
            url: `https://nova.amazon.com/conversation/${NOVA_CONVERSATION_ID}`,
        });
        windowInstance.fetch = async () => new windowInstance.Response(JSON.stringify(terminalNovaConversation));
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch('https://nova.amazon.com/api', {
            method: 'POST',
            headers: { 'x-amz-target': NOVA_CONVERSATION_DETAIL_TARGET },
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(conversationResponseCache.get('Amazon Nova', NOVA_CONVERSATION_ID)).toBeDefined();
    });

    it('should not let an older delayed x.com Grok detail replace a newer terminal detail', async () => {
        const detailUrl = buildXGrokConversationItemsUrl(X_GROK_CONVERSATION_ID);
        const olderText = JSON.stringify(createXGrokPayload('Older Grok answer'));
        const newerText = JSON.stringify(createXGrokPayload('Newer Grok answer'));
        const delayed = createDeferredBodyClone(olderText);
        let responseIndex = 0;
        const windowInstance = new Window({ url: `https://x.com/i/grok?conversation=${X_GROK_CONVERSATION_ID}` });
        windowInstance.fetch = async () => {
            const isOlder = responseIndex++ === 0;
            const response = new windowInstance.Response(isOlder ? olderText : newerText);
            if (isOlder) {
                response.clone = () => delayed.clone as unknown as InstanceType<typeof windowInstance.Response>;
            }
            return response;
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch(detailUrl);
        await windowInstance.fetch(detailUrl);
        await waitForCapture();
        expect(
            conversationResponseCache.get('Grok', X_GROK_CONVERSATION_ID)?.mapping?.['2091428438666096641']?.message
                ?.content.parts?.[0],
        ).toBe('Newer Grok answer');

        delayed.release();
        await waitForCapture();
        expect(
            conversationResponseCache.get('Grok', X_GROK_CONVERSATION_ID)?.mapping?.['2091428438666096641']?.message
                ?.content.parts?.[0],
        ).toBe('Newer Grok answer');
    });

    it('should not let an older delayed Nova detail replace a newer terminal detail', async () => {
        const olderPayload = createNovaConversationFixture();
        const newerPayload = structuredClone(olderPayload) as Record<string, any>;
        newerPayload.conversationInteractions[0].conversationTitle = 'Newer Nova snapshot';
        const olderText = JSON.stringify(olderPayload);
        const newerText = JSON.stringify(newerPayload);
        const delayed = createDeferredBodyClone(olderText);
        let responseIndex = 0;
        const windowInstance = new Window({
            url: `https://nova.amazon.com/conversation/${NOVA_CONVERSATION_ID}`,
        });
        windowInstance.fetch = async () => {
            const isOlder = responseIndex++ === 0;
            const response = new windowInstance.Response(isOlder ? olderText : newerText);
            if (isOlder) {
                response.clone = () => delayed.clone as unknown as InstanceType<typeof windowInstance.Response>;
            }
            return response;
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });
        const request = {
            method: 'POST',
            headers: { 'x-amz-target': NOVA_CONVERSATION_DETAIL_TARGET },
            body: JSON.stringify({ conversationId: NOVA_CONVERSATION_ID }),
        };

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch('https://nova.amazon.com/api', request);
        await windowInstance.fetch('https://nova.amazon.com/api', request);
        await waitForCapture();
        expect(conversationResponseCache.get('Amazon Nova', NOVA_CONVERSATION_ID)?.title).toBe('Newer Nova snapshot');

        delayed.release();
        await waitForCapture();
        expect(conversationResponseCache.get('Amazon Nova', NOVA_CONVERSATION_ID)?.title).toBe('Newer Nova snapshot');
    });

    it('should not let an older delayed Grok XHR replace a newer terminal detail', () => {
        const detailUrl = buildXGrokConversationItemsUrl(X_GROK_CONVERSATION_ID);
        const windowInstance = new Window({ url: `https://x.com/i/grok?conversation=${X_GROK_CONVERSATION_ID}` });
        const transport = installDeferredXhrTransport(windowInstance);
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        const older = new windowInstance.XMLHttpRequest();
        older.open('GET', detailUrl);
        older.send();
        const newer = new windowInstance.XMLHttpRequest();
        newer.open('GET', detailUrl);
        newer.send();

        transport.respond(transport.pending[1]!, JSON.stringify(createXGrokPayload('Newer Grok XHR answer')));
        transport.respond(transport.pending[0]!, JSON.stringify(createXGrokPayload('Older Grok XHR answer')));

        expect(
            conversationResponseCache.get('Grok', X_GROK_CONVERSATION_ID)?.mapping?.['2091428438666096641']?.message
                ?.content.parts?.[0],
        ).toBe('Newer Grok XHR answer');
    });

    it('should preserve a complete DeepSeek snapshot across an empty conditional cache response', async () => {
        const fullPayload = createCurrentDeepSeekHistoryResponse();
        const conditionalPayload = createCurrentDeepSeekHistoryResponse();
        conditionalPayload.data.biz_data.chat_messages = [];
        const windowInstance = new Window({
            url: `https://chat.deepseek.com/a/chat/s/${SYNTHETIC_DEEPSEEK_CONVERSATION_ID}`,
        });
        const transport = installDeferredXhrTransport(windowInstance);
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        const full = new windowInstance.XMLHttpRequest();
        full.open('GET', SYNTHETIC_DEEPSEEK_FULL_HISTORY_URL);
        full.send();
        transport.respond(transport.pending[0]!, JSON.stringify(fullPayload));
        await waitForCapture();
        expect(conversationResponseCache.get('DeepSeek', SYNTHETIC_DEEPSEEK_CONVERSATION_ID)).toBeDefined();

        const conditional = new windowInstance.XMLHttpRequest();
        conditional.open('GET', SYNTHETIC_DEEPSEEK_HISTORY_URL);
        conditional.send();
        transport.respond(transport.pending[1]!, JSON.stringify(conditionalPayload));
        await waitForCapture();

        expect(
            conversationResponseCache.get('DeepSeek', SYNTHETIC_DEEPSEEK_CONVERSATION_ID)?.mapping['202']?.message
                ?.content.parts,
        ).toEqual(['There is no single, universally agreed answer.']);
    });

    it('should not let an older delayed Nova XHR repopulate after a newer non-terminal detail', () => {
        const terminalText = JSON.stringify(createNovaConversationFixture());
        const nonTerminalText = JSON.stringify(
            createNovaConversationFixture({ assistantStatus: 'in_progress', interactionStatus: 'in_progress' }),
        );
        const windowInstance = new Window({
            url: `https://nova.amazon.com/conversation/${NOVA_CONVERSATION_ID}`,
        });
        const transport = installDeferredXhrTransport(windowInstance);
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });
        const requestBody = JSON.stringify({ conversationId: NOVA_CONVERSATION_ID });

        (bootstrapScript as { main: () => void }).main();
        const older = new windowInstance.XMLHttpRequest();
        older.open('POST', 'https://nova.amazon.com/api');
        older.setRequestHeader('x-amz-target', NOVA_CONVERSATION_DETAIL_TARGET);
        older.send(requestBody);
        const newer = new windowInstance.XMLHttpRequest();
        newer.open('POST', 'https://nova.amazon.com/api');
        newer.setRequestHeader('x-amz-target', NOVA_CONVERSATION_DETAIL_TARGET);
        newer.send(requestBody);

        transport.respond(transport.pending[1]!, nonTerminalText);
        transport.respond(transport.pending[0]!, terminalText);

        expect(conversationResponseCache.get('Amazon Nova', NOVA_CONVERSATION_ID)).toBeUndefined();
    });

    it('should start the page fetch before a streamed Request clone finishes inspection', async () => {
        const request = new Request(
            'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&bl=boq&f.sid=123&hl=en&_reqid=42&rt=c',
            { method: 'POST', body: 'f.req=x&at=secret' },
        );
        const delayed = createDeferredBodyClone('f.req=x&at=secret');
        request.clone = () => delayed.clone as unknown as Request;
        let pageFetchStarted = false;
        const windowInstance = new Window({ url: 'https://gemini.google.com/app/synthetic' });
        windowInstance.fetch = async () => {
            pageFetchStarted = true;
            return new windowInstance.Response('{}');
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        const responsePromise = windowInstance.fetch(request as unknown as Parameters<typeof windowInstance.fetch>[0]);
        await waitForCapture();

        expect(pageFetchStarted).toBeTrue();
        delayed.release();
        await responsePromise;
    });

    it('should fail open when a streamed Request clone never finishes', async () => {
        const cancel = mock(async () => undefined);
        const never = new Promise<never>(() => undefined);
        const request = new Request(
            'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&bl=boq&f.sid=123&hl=en&_reqid=42&rt=c',
            { method: 'POST', body: 'f.req=x&at=secret' },
        );
        request.clone = () =>
            ({
                headers: new Headers(),
                body: { getReader: () => ({ read: () => never, cancel }) },
            }) as unknown as Request;
        const windowInstance = new Window({ url: 'https://gemini.google.com/app/synthetic' });
        windowInstance.fetch = async () => new windowInstance.Response('{}');
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
            windowInstance
                .fetch(request as unknown as Parameters<typeof windowInstance.fetch>[0])
                .then(() => 'forwarded'),
            new Promise<string>((resolve) => {
                timeoutHandle = setTimeout(() => resolve('timed-out'), 250);
            }),
        ]);
        clearTimeout(timeoutHandle);

        expect(result).toBe('forwarded');
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('should reject oversized Gemini XHR strings and URLSearchParams before parsing', async () => {
        const windowInstance = new Window({ url: 'https://gemini.google.com/app/synthetic' });
        installDeferredXhrTransport(windowInstance);
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        await withCaptureByteLimit(8, async () => {
            (bootstrapScript as { main: () => void }).main();
            const detailUrl =
                'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&bl=boq&f.sid=123&hl=en&_reqid=42&rt=c';
            const stringXhr = new windowInstance.XMLHttpRequest();
            stringXhr.open('POST', detailUrl);
            stringXhr.send('f.req=x&at=secret');
            const paramsXhr = new windowInstance.XMLHttpRequest();
            paramsXhr.open('POST', detailUrl);
            paramsXhr.send(new URLSearchParams({ 'f.req': 'x', at: 'secret' }) as never);
        });

        expect(getGeminiBatchexecuteContext()).toBeUndefined();
    });

    it('should reserve at most three concurrent response clones', async () => {
        const conversationIds = [
            '67f0a0b3-1234-4abc-8def-123456789001',
            '67f0a0b3-1234-4abc-8def-123456789002',
            '67f0a0b3-1234-4abc-8def-123456789003',
            '67f0a0b3-1234-4abc-8def-123456789004',
        ];
        const delayed = conversationIds.map((conversationId) =>
            createDeferredBodyClone(JSON.stringify(createTerminalChatGptPayload(conversationId))),
        );
        let responseIndex = 0;
        const cloneCalls = conversationIds.map(() => 0);
        const windowInstance = new Window({ url: `https://chatgpt.com/c/${conversationIds[0]}` });
        windowInstance.fetch = async () => {
            const index = responseIndex++;
            const response = new windowInstance.Response('{}');
            response.clone = () => {
                cloneCalls[index] = (cloneCalls[index] ?? 0) + 1;
                return delayed[index]!.clone as unknown as InstanceType<typeof windowInstance.Response>;
            };
            return response;
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        for (const conversationId of conversationIds) {
            await windowInstance.fetch(`https://chatgpt.com/backend-api/conversation/${conversationId}`);
        }
        await waitForCapture();

        expect(cloneCalls).toEqual([1, 1, 1, 0]);
        delayed.forEach((capture) => {
            capture.release();
        });
        await waitForCapture();
    });

    it('assembles Meta detail and cursor-ordered pagination responses before caching', async () => {
        const detailRequest = buildMetaConversationDetailRequest(SYNTHETIC_META_CONVERSATION_ID, {
            documentId: 'synthetic-detail-document',
        });
        const paginationRequest = buildMetaConversationPaginationRequest(
            {
                conversationId: SYNTHETIC_META_CONVERSATION_ID,
                before: 'synthetic-before-cursor',
                last: 20,
            },
            { documentId: 'synthetic-pagination-document' },
        );
        if (!detailRequest || !paginationRequest) {
            throw new Error('expected synthetic Meta requests');
        }
        const responses = [createMetaDetailFixture({ hasPreviousPage: true }), createMetaOlderPageFixture()];
        const windowInstance = new Window({
            url: `https://www.meta.ai/prompt/${SYNTHETIC_META_CONVERSATION_ID}`,
        });
        windowInstance.fetch = async () =>
            new windowInstance.Response(JSON.stringify(responses.shift()), {
                headers: { 'content-type': 'application/json' },
            });
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch(detailRequest.url, {
            method: detailRequest.method,
            headers: detailRequest.headers,
            body: detailRequest.body,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(conversationResponseCache.get('Meta Muse', SYNTHETIC_META_CONVERSATION_ID)).toBeUndefined();

        await windowInstance.fetch(paginationRequest.url, {
            method: paginationRequest.method,
            headers: paginationRequest.headers,
            body: paginationRequest.body,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(conversationResponseCache.get('Meta Muse', SYNTHETIC_META_CONVERSATION_ID)).toBeDefined();
    });

    it('should invalidate a cached Meta snapshot when a newer initial response is non-terminal', async () => {
        const conversationId = '66666666-6666-4666-8666-666666666666';
        const detailRequest = buildMetaConversationDetailRequest(conversationId, {
            documentId: 'synthetic-detail-document',
        });
        if (!detailRequest) {
            throw new Error('expected synthetic Meta request');
        }
        const responsePayload = JSON.parse(
            JSON.stringify(createMetaDetailFixture({ assistantStreamingState: 'STREAMING' })).replaceAll(
                SYNTHETIC_META_CONVERSATION_ID,
                conversationId,
            ),
        ) as unknown;
        conversationResponseCache.set(
            'Meta Muse',
            createTerminalChatGptPayload(conversationId, 'Superseded Meta snapshot'),
        );
        const windowInstance = new Window({ url: `https://www.meta.ai/prompt/${conversationId}` });
        windowInstance.fetch = async () => new windowInstance.Response(JSON.stringify(responsePayload));
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch(detailRequest.url, {
            method: detailRequest.method,
            headers: detailRequest.headers,
            body: detailRequest.body,
        });
        await waitForCapture();

        expect(conversationResponseCache.get('Meta Muse', conversationId)).toBeUndefined();
    });

    it('should invalidate a cached Meta snapshot when a newer initial response requires missing pagination', async () => {
        const conversationId = '77777777-7777-4777-8777-777777777777';
        const detailRequest = buildMetaConversationDetailRequest(conversationId, {
            documentId: 'synthetic-detail-document',
        });
        if (!detailRequest) {
            throw new Error('expected synthetic Meta request');
        }
        const responsePayload = JSON.parse(
            JSON.stringify(createMetaDetailFixture({ hasPreviousPage: true })).replaceAll(
                SYNTHETIC_META_CONVERSATION_ID,
                conversationId,
            ),
        ) as unknown;
        conversationResponseCache.set(
            'Meta Muse',
            createTerminalChatGptPayload(conversationId, 'Superseded Meta snapshot'),
        );
        const windowInstance = new Window({ url: `https://www.meta.ai/prompt/${conversationId}` });
        windowInstance.fetch = async () => new windowInstance.Response(JSON.stringify(responsePayload));
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch(detailRequest.url, {
            method: detailRequest.method,
            headers: detailRequest.headers,
            body: detailRequest.body,
        });
        await waitForCapture();

        expect(conversationResponseCache.get('Meta Muse', conversationId)).toBeUndefined();
    });

    it('should not invalidate a cached Meta snapshot when only a pagination half starts', async () => {
        const conversationId = '88888888-8888-4888-8888-888888888888';
        const paginationRequest = buildMetaConversationPaginationRequest(
            { conversationId, before: 'synthetic-before-cursor', last: 20 },
            { documentId: 'synthetic-pagination-document' },
        );
        if (!paginationRequest) {
            throw new Error('expected synthetic Meta pagination request');
        }
        conversationResponseCache.set(
            'Meta Muse',
            createTerminalChatGptPayload(conversationId, 'Current Meta snapshot'),
        );
        const windowInstance = new Window({ url: `https://www.meta.ai/prompt/${conversationId}` });
        windowInstance.fetch = async () =>
            new windowInstance.Response(JSON.stringify(createMetaOlderPageFixture(conversationId)));
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch(paginationRequest.url, {
            method: paginationRequest.method,
            headers: paginationRequest.headers,
            body: paginationRequest.body,
        });
        await waitForCapture();

        expect(conversationResponseCache.get('Meta Muse', conversationId)?.title).toBe('Current Meta snapshot');
    });

    it('should assemble Meta responses when the initial clone finishes after pagination', async () => {
        const conversationId = '33333333-3333-4333-8333-333333333333';
        const withConversationId = (fixture: unknown) =>
            JSON.parse(JSON.stringify(fixture).replaceAll(SYNTHETIC_META_CONVERSATION_ID, conversationId)) as unknown;
        const detailRequest = buildMetaConversationDetailRequest(conversationId, {
            documentId: 'synthetic-detail-document',
        });
        const paginationRequest = buildMetaConversationPaginationRequest(
            {
                conversationId,
                before: 'synthetic-before-cursor',
                last: 20,
            },
            { documentId: 'synthetic-pagination-document' },
        );
        if (!detailRequest || !paginationRequest) {
            throw new Error('expected synthetic Meta requests');
        }
        const detailText = JSON.stringify(withConversationId(createMetaDetailFixture({ hasPreviousPage: true })));
        const delayedDetail = createDeferredBodyClone(detailText);
        let responseIndex = 0;
        const windowInstance = new Window({
            url: `https://www.meta.ai/prompt/${conversationId}`,
        });
        windowInstance.fetch = async () => {
            const index = responseIndex++;
            const response = new windowInstance.Response(
                index === 0 ? detailText : JSON.stringify(withConversationId(createMetaOlderPageFixture())),
            );
            if (index === 0) {
                response.clone = () => delayedDetail.clone as unknown as InstanceType<typeof windowInstance.Response>;
            }
            return response;
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch(detailRequest.url, {
            method: detailRequest.method,
            headers: detailRequest.headers,
            body: detailRequest.body,
        });
        await windowInstance.fetch(paginationRequest.url, {
            method: paginationRequest.method,
            headers: paginationRequest.headers,
            body: paginationRequest.body,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(conversationResponseCache.get('Meta Muse', conversationId)).toBeUndefined();

        delayedDetail.release();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(conversationResponseCache.get('Meta Muse', conversationId)).toBeDefined();
    });

    it('should preserve newer Meta assembly when an older initial request body finishes inspection late', async () => {
        const conversationId = '44444444-4444-4444-8444-444444444444';
        const withConversationId = (fixture: unknown) =>
            JSON.parse(JSON.stringify(fixture).replaceAll(SYNTHETIC_META_CONVERSATION_ID, conversationId)) as unknown;
        const detailRequest = buildMetaConversationDetailRequest(conversationId, {
            documentId: 'synthetic-detail-document',
        });
        const paginationRequest = buildMetaConversationPaginationRequest(
            { conversationId, before: 'synthetic-before-cursor', last: 20 },
            { documentId: 'synthetic-pagination-document' },
        );
        if (!detailRequest || !paginationRequest) {
            throw new Error('expected synthetic Meta requests');
        }
        const delayedRequestBody = createDeferredBodyClone(detailRequest.body);
        const olderRequest = new Request(detailRequest.url, {
            method: detailRequest.method,
            headers: detailRequest.headers,
            body: detailRequest.body,
        });
        olderRequest.clone = () => delayedRequestBody.clone as unknown as Request;
        const responsePayloads = [
            createMetaDetailFixture({ hasPreviousPage: true }),
            createMetaDetailFixture({ hasPreviousPage: true }),
            createMetaOlderPageFixture(),
        ];
        const windowInstance = new Window({ url: `https://www.meta.ai/prompt/${conversationId}` });
        windowInstance.fetch = async () =>
            new windowInstance.Response(JSON.stringify(withConversationId(responsePayloads.shift())));
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        const olderFetch = windowInstance.fetch(olderRequest as unknown as Parameters<typeof windowInstance.fetch>[0]);
        await windowInstance.fetch(detailRequest.url, {
            method: detailRequest.method,
            headers: detailRequest.headers,
            body: detailRequest.body,
        });
        await waitForCapture();

        delayedRequestBody.release();
        await olderFetch;
        await waitForCapture();
        await windowInstance.fetch(paginationRequest.url, {
            method: paginationRequest.method,
            headers: paginationRequest.headers,
            body: paginationRequest.body,
        });
        await waitForCapture();

        expect(conversationResponseCache.get('Meta Muse', conversationId)).toBeDefined();
    });

    it('should reject delayed Meta assembly from before provider auth invalidation', async () => {
        const conversationId = '55555555-5555-4555-8555-555555555555';
        const withConversationId = (fixture: unknown) =>
            JSON.parse(JSON.stringify(fixture).replaceAll(SYNTHETIC_META_CONVERSATION_ID, conversationId)) as unknown;
        const detailRequest = buildMetaConversationDetailRequest(conversationId, {
            documentId: 'synthetic-detail-document',
        });
        const paginationRequest = buildMetaConversationPaginationRequest(
            { conversationId, before: 'synthetic-before-cursor', last: 20 },
            { documentId: 'synthetic-pagination-document' },
        );
        if (!detailRequest || !paginationRequest) {
            throw new Error('expected synthetic Meta requests');
        }
        const detailText = JSON.stringify(withConversationId(createMetaDetailFixture({ hasPreviousPage: true })));
        const delayed = createDeferredBodyClone(detailText);
        let responseIndex = 0;
        const windowInstance = new Window({ url: `https://www.meta.ai/prompt/${conversationId}` });
        windowInstance.fetch = async () => {
            const response = new windowInstance.Response(
                responseIndex++ === 0 ? detailText : JSON.stringify(withConversationId(createMetaOlderPageFixture())),
            );
            if (responseIndex === 1) {
                response.clone = () => delayed.clone as unknown as InstanceType<typeof windowInstance.Response>;
            }
            return response;
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch(detailRequest.url, {
            method: detailRequest.method,
            headers: detailRequest.headers,
            body: detailRequest.body,
        });
        expect(invalidateCapturedRequestContext(detailRequest.url, 401)).toBeTrue();
        delayed.release();
        await waitForCapture();
        await windowInstance.fetch(paginationRequest.url, {
            method: paginationRequest.method,
            headers: paginationRequest.headers,
            body: paginationRequest.body,
        });
        await waitForCapture();

        expect(conversationResponseCache.get('Meta Muse', conversationId)).toBeUndefined();
    });

    it('assembles Z.ai detail metadata and the exact requested message batch before caching', async () => {
        const batchRequest = buildZaiMessagesBatchRequest(zaiDetailPayloadFixture);
        if (!batchRequest) {
            throw new Error('expected synthetic Z.ai batch request');
        }
        const responses = [zaiDetailPayloadFixture, zaiMessagesBatchPayloadFixture];
        const windowInstance = new Window({ url: `https://chat.z.ai/c/${ZAI_CONVERSATION_ID}` });
        windowInstance.fetch = async () => new windowInstance.Response(JSON.stringify(responses.shift()));
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch(`https://chat.z.ai/api/v1/chats/${ZAI_CONVERSATION_ID}`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(conversationResponseCache.get('Z.ai', ZAI_CONVERSATION_ID)).toBeUndefined();

        await windowInstance.fetch(batchRequest.url, {
            method: batchRequest.method,
            headers: batchRequest.headers,
            body: batchRequest.body,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(conversationResponseCache.get('Z.ai', ZAI_CONVERSATION_ID)).toBeDefined();
    });

    it('should invalidate a cached Z.ai snapshot when a newer sequence is missing its message batch', async () => {
        const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const detailPayload = JSON.parse(
            JSON.stringify(zaiDetailPayloadFixture).replaceAll(ZAI_CONVERSATION_ID, conversationId),
        ) as unknown;
        conversationResponseCache.set('Z.ai', createTerminalChatGptPayload(conversationId, 'Superseded Z.ai snapshot'));
        const windowInstance = new Window({ url: `https://chat.z.ai/c/${conversationId}` });
        windowInstance.fetch = async () => new windowInstance.Response(JSON.stringify(detailPayload));
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch(`https://chat.z.ai/api/v1/chats/${conversationId}`);
        await waitForCapture();

        expect(conversationResponseCache.get('Z.ai', conversationId)).toBeUndefined();
    });

    it('should invalidate a cached Z.ai snapshot when a newer assembled sequence is non-terminal', async () => {
        const conversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        const detailPayload = JSON.parse(
            JSON.stringify(zaiDetailPayloadFixture).replaceAll(ZAI_CONVERSATION_ID, conversationId),
        ) as typeof zaiDetailPayloadFixture;
        const batchRequest = buildZaiMessagesBatchRequest(detailPayload);
        if (!batchRequest) {
            throw new Error('expected synthetic Z.ai batch request');
        }
        const nonTerminalBatch = JSON.parse(
            JSON.stringify(zaiMessagesBatchPayloadFixture).replaceAll(ZAI_CONVERSATION_ID, conversationId),
        ) as typeof zaiMessagesBatchPayloadFixture;
        nonTerminalBatch.data[ZAI_ASSISTANT_MESSAGE_ID].done = false;
        const responses = [detailPayload, nonTerminalBatch];
        conversationResponseCache.set('Z.ai', createTerminalChatGptPayload(conversationId, 'Superseded Z.ai snapshot'));
        const windowInstance = new Window({ url: `https://chat.z.ai/c/${conversationId}` });
        windowInstance.fetch = async () => new windowInstance.Response(JSON.stringify(responses.shift()));
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch(`https://chat.z.ai/api/v1/chats/${conversationId}`);
        await windowInstance.fetch(batchRequest.url, {
            method: batchRequest.method,
            headers: batchRequest.headers,
            body: batchRequest.body,
        });
        await waitForCapture();

        expect(conversationResponseCache.get('Z.ai', conversationId)).toBeUndefined();
    });

    it('should not invalidate a cached Z.ai snapshot when only a message-batch half starts', async () => {
        const conversationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        const detailPayload = JSON.parse(
            JSON.stringify(zaiDetailPayloadFixture).replaceAll(ZAI_CONVERSATION_ID, conversationId),
        ) as typeof zaiDetailPayloadFixture;
        const batchPayload = JSON.parse(
            JSON.stringify(zaiMessagesBatchPayloadFixture).replaceAll(ZAI_CONVERSATION_ID, conversationId),
        ) as typeof zaiMessagesBatchPayloadFixture;
        const batchRequest = buildZaiMessagesBatchRequest(detailPayload);
        if (!batchRequest) {
            throw new Error('expected synthetic Z.ai batch request');
        }
        conversationResponseCache.set('Z.ai', createTerminalChatGptPayload(conversationId, 'Current Z.ai snapshot'));
        const windowInstance = new Window({ url: `https://chat.z.ai/c/${conversationId}` });
        windowInstance.fetch = async () => new windowInstance.Response(JSON.stringify(batchPayload));
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch(batchRequest.url, {
            method: batchRequest.method,
            headers: batchRequest.headers,
            body: batchRequest.body,
        });
        await waitForCapture();

        expect(conversationResponseCache.get('Z.ai', conversationId)?.title).toBe('Current Z.ai snapshot');
    });

    it('should assemble Z.ai responses when the detail clone finishes after the message batch', async () => {
        const batchRequest = buildZaiMessagesBatchRequest(zaiDetailPayloadFixture);
        if (!batchRequest) {
            throw new Error('expected synthetic Z.ai batch request');
        }
        const detailText = JSON.stringify(zaiDetailPayloadFixture);
        const delayedDetail = createDeferredBodyClone(detailText);
        let responseIndex = 0;
        const windowInstance = new Window({ url: `https://chat.z.ai/c/${ZAI_CONVERSATION_ID}` });
        windowInstance.fetch = async () => {
            const index = responseIndex++;
            const response = new windowInstance.Response(
                index === 0 ? detailText : JSON.stringify(zaiMessagesBatchPayloadFixture),
            );
            if (index === 0) {
                response.clone = () => delayedDetail.clone as unknown as InstanceType<typeof windowInstance.Response>;
            }
            return response;
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        await windowInstance.fetch(`https://chat.z.ai/api/v1/chats/${ZAI_CONVERSATION_ID}`);
        await windowInstance.fetch(batchRequest.url, {
            method: batchRequest.method,
            headers: batchRequest.headers,
            body: batchRequest.body,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(conversationResponseCache.get('Z.ai', ZAI_CONVERSATION_ID)).toBeUndefined();

        delayedDetail.release();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(conversationResponseCache.get('Z.ai', ZAI_CONVERSATION_ID)).toBeDefined();
    });

    it('should reject delayed Z.ai assembly from before provider auth invalidation', async () => {
        const batchRequest = buildZaiMessagesBatchRequest(zaiDetailPayloadFixture);
        if (!batchRequest) {
            throw new Error('expected synthetic Z.ai batch request');
        }
        const detailText = JSON.stringify(zaiDetailPayloadFixture);
        const delayed = createDeferredBodyClone(detailText);
        let responseIndex = 0;
        const windowInstance = new Window({ url: `https://chat.z.ai/c/${ZAI_CONVERSATION_ID}` });
        windowInstance.fetch = async () => {
            const response = new windowInstance.Response(
                responseIndex++ === 0 ? detailText : JSON.stringify(zaiMessagesBatchPayloadFixture),
            );
            if (responseIndex === 1) {
                response.clone = () => delayed.clone as unknown as InstanceType<typeof windowInstance.Response>;
            }
            return response;
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        const detailUrl = `https://chat.z.ai/api/v1/chats/${ZAI_CONVERSATION_ID}`;
        await windowInstance.fetch(detailUrl);
        expect(invalidateCapturedRequestContext(detailUrl, 403)).toBeTrue();
        delayed.release();
        await waitForCapture();
        await windowInstance.fetch(batchRequest.url, {
            method: batchRequest.method,
            headers: batchRequest.headers,
            body: batchRequest.body,
        });
        await waitForCapture();

        expect(conversationResponseCache.get('Z.ai', ZAI_CONVERSATION_ID)).toBeUndefined();
    });

    it('should cancel an oversized Meta Request clone before request-body classification', async () => {
        const detailRequest = buildMetaConversationDetailRequest(SYNTHETIC_META_CONVERSATION_ID, {
            documentId: 'synthetic-detail-document',
        });
        if (!detailRequest) {
            throw new Error('expected synthetic Meta request');
        }
        const request = new Request(detailRequest.url, { method: detailRequest.method, body: detailRequest.body });
        const oversized = createImmediateBodyClone(detailRequest.body);
        request.clone = () => oversized.clone as unknown as Request;
        const windowInstance = new Window({
            url: `https://www.meta.ai/prompt/${SYNTHETIC_META_CONVERSATION_ID}`,
        });
        windowInstance.fetch = async () => new windowInstance.Response('{}');
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        await withCaptureByteLimit(8, async () => {
            (bootstrapScript as { main: () => void }).main();
            await windowInstance.fetch(request as unknown as Parameters<typeof windowInstance.fetch>[0]);
            await waitForCapture();
        });

        expect(oversized.cancel).toHaveBeenCalledTimes(1);
        expect(await request.text()).toBe(detailRequest.body);
    });

    it('should reject oversized URLSearchParams before serializing the request body', async () => {
        const params = new URLSearchParams({ padding: 'x'.repeat(32) });
        const serialize = mock(params.toString.bind(params));
        params.toString = serialize;
        const windowInstance = new Window({
            url: `https://www.meta.ai/prompt/${SYNTHETIC_META_CONVERSATION_ID}`,
        });
        windowInstance.fetch = async () => new windowInstance.Response('{}');
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        await withCaptureByteLimit(8, async () => {
            (bootstrapScript as { main: () => void }).main();
            await windowInstance.fetch('https://www.meta.ai/api/graphql', {
                method: 'POST',
                body: params,
            } as unknown as Parameters<typeof windowInstance.fetch>[1]);
            await waitForCapture();
        });

        expect(serialize).not.toHaveBeenCalled();
    });

    it('should cancel an oversized Z.ai Request clone before batch-body classification', async () => {
        const batchRequest = buildZaiMessagesBatchRequest(zaiDetailPayloadFixture);
        if (!batchRequest) {
            throw new Error('expected synthetic Z.ai batch request');
        }
        const request = new Request(batchRequest.url, { method: batchRequest.method, body: batchRequest.body });
        const oversized = createImmediateBodyClone(batchRequest.body);
        request.clone = () => oversized.clone as unknown as Request;
        const windowInstance = new Window({ url: `https://chat.z.ai/c/${ZAI_CONVERSATION_ID}` });
        windowInstance.fetch = async () => new windowInstance.Response(JSON.stringify(zaiMessagesBatchPayloadFixture));
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        await withCaptureByteLimit(8, async () => {
            (bootstrapScript as { main: () => void }).main();
            await windowInstance.fetch(request as unknown as Parameters<typeof windowInstance.fetch>[0]);
            await waitForCapture();
        });

        expect(oversized.cancel).toHaveBeenCalledTimes(1);
        expect(await request.text()).toBe(batchRequest.body);
    });

    it('should cancel an oversized Meta response clone before parsing it', async () => {
        const detailRequest = buildMetaConversationDetailRequest(SYNTHETIC_META_CONVERSATION_ID, {
            documentId: 'synthetic-detail-document',
        });
        if (!detailRequest) {
            throw new Error('expected synthetic Meta request');
        }
        const responseText = JSON.stringify(createMetaDetailFixture());
        const oversized = createImmediateBodyClone(responseText);
        const windowInstance = new Window({
            url: `https://www.meta.ai/prompt/${SYNTHETIC_META_CONVERSATION_ID}`,
        });
        windowInstance.fetch = async () => {
            const response = new windowInstance.Response(responseText);
            response.clone = () => oversized.clone as unknown as InstanceType<typeof windowInstance.Response>;
            return response;
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });
        conversationResponseCache.set(
            'Meta Muse',
            createTerminalChatGptPayload(SYNTHETIC_META_CONVERSATION_ID, 'Superseded Meta snapshot'),
        );

        const requestBodyBytes = new TextEncoder().encode(detailRequest.body).byteLength;
        await withCaptureByteLimit(requestBodyBytes, async () => {
            (bootstrapScript as { main: () => void }).main();
            const pageResponse = await windowInstance.fetch(detailRequest.url, {
                method: detailRequest.method,
                headers: detailRequest.headers,
                body: detailRequest.body,
            });
            expect(await pageResponse.text()).toBe(responseText);
            await waitForCapture();
        });

        expect(oversized.cancel).toHaveBeenCalledTimes(1);
        expect(conversationResponseCache.get('Meta Muse', SYNTHETIC_META_CONVERSATION_ID)).toBeUndefined();
    });

    it('should cancel an oversized Z.ai response clone before parsing it', async () => {
        const responseText = JSON.stringify(zaiDetailPayloadFixture);
        const oversized = createImmediateBodyClone(responseText);
        const windowInstance = new Window({ url: `https://chat.z.ai/c/${ZAI_CONVERSATION_ID}` });
        windowInstance.fetch = async () => {
            const response = new windowInstance.Response(responseText);
            response.clone = () => oversized.clone as unknown as InstanceType<typeof windowInstance.Response>;
            return response;
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });
        conversationResponseCache.set(
            'Z.ai',
            createTerminalChatGptPayload(ZAI_CONVERSATION_ID, 'Superseded Z.ai snapshot'),
        );

        await withCaptureByteLimit(8, async () => {
            (bootstrapScript as { main: () => void }).main();
            const pageResponse = await windowInstance.fetch(`https://chat.z.ai/api/v1/chats/${ZAI_CONVERSATION_ID}`);
            expect(await pageResponse.text()).toBe(responseText);
            await waitForCapture();
        });

        expect(oversized.cancel).toHaveBeenCalledTimes(1);
        expect(conversationResponseCache.get('Z.ai', ZAI_CONVERSATION_ID)).toBeUndefined();
    });

    it('clears captured ChatGPT auth context after an unauthorized response', async () => {
        const windowInstance = new Window();
        windowInstance.fetch = async () => new windowInstance.Response('unauthorized', { status: 401 });
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });
        platformHeaderStore.update('ChatGPT', {
            authorization: 'Bearer stale-token',
            'oai-device-id': 'stale-device',
        });
        conversationResponseCache.set('ChatGPT', {
            title: 'stale account conversation',
            create_time: 1,
            update_time: 1,
            mapping: {},
            conversation_id: 'stale',
            current_node: 'root',
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'synthetic-model',
            safe_urls: [],
            blocked_urls: [],
        });

        (bootstrapScript as { main: () => void }).main();

        const response = await windowInstance.fetch('https://chatgpt.com/backend-api/conversation/stale', {
            headers: { authorization: 'Bearer stale-token' },
        });

        expect(response.status).toBe(401);
        expect(platformHeaderStore.get('ChatGPT')).toBeUndefined();
        expect(conversationResponseCache.get('ChatGPT', 'stale')).toBeUndefined();
    });

    it('should clear cached provider conversations when captured account identity changes', async () => {
        const conversationId = 'identity-bound';
        platformHeaderStore.update('ChatGPT', { authorization: 'Bearer old-account' });
        conversationResponseCache.set('ChatGPT', {
            title: 'old account conversation',
            create_time: 1,
            update_time: 1,
            mapping: {},
            conversation_id: conversationId,
            current_node: 'root',
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'synthetic-model',
            safe_urls: [],
            blocked_urls: [],
        });

        await captureFetchRequestContext(
            ['https://chatgpt.com/backend-api/conversations', { headers: { authorization: 'Bearer new-account' } }],
            'https://chatgpt.com/backend-api/conversations',
            'GET',
        );

        expect(conversationResponseCache.get('ChatGPT', conversationId)).toBeUndefined();
    });

    it('should clear cached conversations when provider identity is re-established after context loss', async () => {
        const conversationId = 'identity-context-lost';
        platformHeaderStore.update('ChatGPT', { authorization: 'Bearer old-account' });
        conversationResponseCache.set('ChatGPT', {
            title: 'old account conversation',
            create_time: 1,
            update_time: 1,
            mapping: {},
            conversation_id: conversationId,
            current_node: 'root',
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'synthetic-model',
            safe_urls: [],
            blocked_urls: [],
        });
        platformHeaderStore.clear('ChatGPT');

        await captureFetchRequestContext(
            ['https://chatgpt.com/backend-api/conversations', { headers: { authorization: 'Bearer new-account' } }],
            'https://chatgpt.com/backend-api/conversations',
            'GET',
        );

        expect(conversationResponseCache.get('ChatGPT', conversationId)).toBeUndefined();
    });

    it('clears Gemini auth headers and batchexecute context after a forbidden response', async () => {
        const windowInstance = new Window();
        windowInstance.fetch = async () => new windowInstance.Response('forbidden', { status: 403 });
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();

        await windowInstance.fetch(
            'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&bl=boq&_reqid=42',
            {
                method: 'POST',
                headers: { authorization: 'Bearer stale-gemini-token' },
                body: 'f.req=%5B%5D&at=STALE-AT',
            },
        );

        expect(platformHeaderStore.get('Gemini')).toBeUndefined();
        expect(getGeminiBatchexecuteContext()).toBeUndefined();
    });
});
