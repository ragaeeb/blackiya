import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import {
    GEMINI_BATCHEXECUTE_CONTEXT_REQUEST_MESSAGE,
    GEMINI_BATCHEXECUTE_CONTEXT_RESPONSE_MESSAGE,
    type GeminiBatchexecuteContextRequestMessage,
} from '@/utils/gemini-batchexecute-bridge';
import { setSessionToken, stampToken } from '@/utils/protocol/session-token';
import { requestGeminiBatchexecuteContextFromMainWorld } from '@/features/runtime/gemini-context-request';

describe('v3 Gemini context request', () => {
    let windowInstance: Window;
    let originalWindow: unknown;

    beforeEach(() => {
        windowInstance = new Window();
        originalWindow = (globalThis as any).window;
        (globalThis as any).window = windowInstance;
        setSessionToken('bk:v3-gemini-context');
    });

    afterEach(() => {
        (globalThis as any).window = originalWindow;
    });

    it('should resolve the captured Gemini batchexecute context', async () => {
        windowInstance.addEventListener('message', ((event: MessageEvent) => {
            const request = event.data as GeminiBatchexecuteContextRequestMessage;
            if (request?.type !== GEMINI_BATCHEXECUTE_CONTEXT_REQUEST_MESSAGE) {
                return;
            }
            windowInstance.postMessage(
                stampToken({
                    type: GEMINI_BATCHEXECUTE_CONTEXT_RESPONSE_MESSAGE,
                    requestId: request.requestId,
                    context: { at: 'test-at', updatedAt: 1 },
                }),
                windowInstance.location.origin,
            );
        }) as any);

        await expect(requestGeminiBatchexecuteContextFromMainWorld(100)).resolves.toEqual({
            at: 'test-at',
            updatedAt: 1,
        });
    });

    it('should return undefined when the main world does not respond', async () => {
        await expect(requestGeminiBatchexecuteContextFromMainWorld(5)).resolves.toBeUndefined();
    });
});
