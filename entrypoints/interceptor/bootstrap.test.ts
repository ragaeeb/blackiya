import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import {
    captureFetchRequestContext,
    default as bootstrapScript,
    isGeminiBatchexecutePost,
} from '@/entrypoints/interceptor/bootstrap';
import {
    getGeminiBatchexecuteContext,
    resetGeminiBatchexecuteContext,
} from '@/entrypoints/interceptor/gemini-batchexecute-context-store';
import { streamDebugRecorder } from '@/features/stream-debug/recorder';
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
    });

    it('recognizes only Gemini batchexecute POST requests for body capture', () => {
        expect(
            isGeminiBatchexecutePost(
                'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb',
                'POST',
            ),
        ).toBeTrue();
        expect(
            isGeminiBatchexecutePost(
                'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb',
                'GET',
            ),
        ).toBeFalse();
        expect(
            isGeminiBatchexecutePost('https://chatgpt.com/_/BardChatUi/data/batchexecute', 'POST'),
        ).toBeFalse();
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
