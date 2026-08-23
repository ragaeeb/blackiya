import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import {
    default as bootstrapScript,
    captureFetchRequestContext,
    isGeminiBatchexecutePost,
} from '@/entrypoints/interceptor/bootstrap';
import {
    getGeminiBatchexecuteContext,
    resetGeminiBatchexecuteContext,
} from '@/entrypoints/interceptor/gemini-batchexecute-context-store';
import { conversationResponseCache } from '@/features/single-export/conversation-response-cache';
import { streamDebugRecorder } from '@/features/stream-debug/recorder';
import {
    createMetaDetailFixture,
    createMetaOlderPageFixture,
    SYNTHETIC_META_CONVERSATION_ID,
} from '@/platforms/meta/fixtures/conversation';
import { buildMetaConversationDetailRequest, buildMetaConversationPaginationRequest } from '@/platforms/meta/request';
import { NOVA_CONVERSATION_DETAIL_TARGET } from '@/platforms/nova/constants';
import { NOVA_CONVERSATION_ID, terminalNovaConversation } from '@/platforms/nova/fixtures/conversation';
import {
    ZAI_CONVERSATION_ID,
    zaiDetailPayloadFixture,
    zaiMessagesBatchPayloadFixture,
} from '@/platforms/zai/fixtures/har-derived';
import { buildZaiMessagesBatchRequest } from '@/platforms/zai/requests';
import { platformHeaderStore } from '@/utils/platform-header-store';

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
        const payload = {
            title: 'Observed response',
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
        };
        const windowInstance = new Window({ url: `https://chatgpt.com/c/${conversationId}` });
        windowInstance.fetch = async () => new windowInstance.Response(JSON.stringify(payload));
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowInstance,
            writable: true,
        });

        (bootstrapScript as { main: () => void }).main();
        const response = await windowInstance.fetch(`https://chatgpt.com/backend-api/conversation/${conversationId}`);

        expect(await response.text()).toBe(JSON.stringify(payload));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(conversationResponseCache.get('ChatGPT', conversationId)?.title).toBe('Observed response');
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

        (bootstrapScript as { main: () => void }).main();

        const response = await windowInstance.fetch('https://chatgpt.com/backend-api/conversation/stale', {
            headers: { authorization: 'Bearer stale-token' },
        });

        expect(response.status).toBe(401);
        expect(platformHeaderStore.get('ChatGPT')).toBeUndefined();
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
