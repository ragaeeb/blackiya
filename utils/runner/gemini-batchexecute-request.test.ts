import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import {
    GEMINI_BATCHEXECUTE_CONTEXT_REQUEST_MESSAGE,
    GEMINI_BATCHEXECUTE_CONTEXT_RESPONSE_MESSAGE,
    type GeminiBatchexecuteContextRequestMessage,
} from '@/utils/gemini-batchexecute-bridge';
import { getSessionToken, setSessionToken, stampToken } from '@/utils/protocol/session-token';
import { requestGeminiBatchexecuteContextFromMainWorld } from '@/utils/runner/gemini-batchexecute-request';

describe('gemini-batchexecute-request', () => {
    let windowInstance: Window;
    let originalWindow: unknown;

    beforeEach(() => {
        windowInstance = new Window();
        originalWindow = (globalThis as any).window;
        (globalThis as any).window = windowInstance;
        setSessionToken('bk:test-gemini-context-request');
    });

    afterEach(() => {
        (globalThis as any).window = originalWindow;
    });

    it('should request and resolve gemini batchexecute context from main world response', async () => {
        windowInstance.addEventListener('message', ((event: MessageEvent) => {
            const request = event.data as GeminiBatchexecuteContextRequestMessage;
            if (request?.type !== GEMINI_BATCHEXECUTE_CONTEXT_REQUEST_MESSAGE) {
                return;
            }
            windowInstance.postMessage(
                stampToken({
                    type: GEMINI_BATCHEXECUTE_CONTEXT_RESPONSE_MESSAGE,
                    requestId: request.requestId,
                    context: {
                        bl: 'boq',
                        fSid: '123',
                        hl: 'en',
                        rt: 'c',
                        reqid: 42,
                        at: 'AJvToken:1',
                        updatedAt: Date.now(),
                    },
                }),
                windowInstance.location.origin,
            );
        }) as any);

        const context = await requestGeminiBatchexecuteContextFromMainWorld(250);
        expect(context?.bl).toBe('boq');
        expect(context?.at).toBe('AJvToken:1');
    });

    it('should return undefined on timeout', async () => {
        const context = await requestGeminiBatchexecuteContextFromMainWorld(25);
        expect(context).toBeUndefined();
    });

    it('should ignore mismatched token responses', async () => {
        windowInstance.addEventListener('message', ((event: MessageEvent) => {
            const request = event.data as GeminiBatchexecuteContextRequestMessage;
            if (request?.type !== GEMINI_BATCHEXECUTE_CONTEXT_REQUEST_MESSAGE) {
                return;
            }
            windowInstance.postMessage(
                {
                    type: GEMINI_BATCHEXECUTE_CONTEXT_RESPONSE_MESSAGE,
                    requestId: request.requestId,
                    context: { at: 'wrong', updatedAt: Date.now() },
                    __blackiyaToken: 'bk:wrong-token',
                },
                windowInstance.location.origin,
            );
        }) as any);

        const context = await requestGeminiBatchexecuteContextFromMainWorld(50);
        expect(context).toBeUndefined();
        expect(getSessionToken()).toBe('bk:test-gemini-context-request');
    });
});
