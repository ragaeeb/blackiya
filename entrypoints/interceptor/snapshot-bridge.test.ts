import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import { BRIDGE_ERROR_CODES } from '@/entrypoints/interceptor/public-api-contract';
import { BlackiyaBridgeError, createWindowJsonRequester } from '@/entrypoints/interceptor/snapshot-bridge';
import { setSessionToken } from '@/utils/protocol/session-token';

describe('snapshot-bridge', () => {
    const windowInstance = new Window();
    let originalWindow: unknown;

    beforeEach(() => {
        originalWindow = (globalThis as any).window;
        (globalThis as any).window = windowInstance;
        setSessionToken('bk:test-bridge-token');
    });

    afterEach(() => {
        (globalThis as any).window = originalWindow;
    });

    it('should stamp token on getJSON bridge requests', async () => {
        const requester = createWindowJsonRequester(windowInstance as any, {
            requestType: 'BLACKIYA_GET_JSON_REQUEST',
            responseType: 'BLACKIYA_GET_JSON_RESPONSE',
            timeoutMs: 100,
            makeRequestId: () => 'request-1',
        });

        let seenRequest: Record<string, unknown> | null = null;
        const handler = (event: any) => {
            const message = event.data as Record<string, unknown> | null;
            if (message?.type !== 'BLACKIYA_GET_JSON_REQUEST') {
                return;
            }
            seenRequest = message;
            windowInstance.postMessage(
                {
                    type: 'BLACKIYA_GET_JSON_RESPONSE',
                    requestId: 'request-1',
                    success: true,
                    data: { ok: true },
                    __blackiyaToken: 'bk:test-bridge-token',
                },
                windowInstance.location.origin,
            );
        };
        windowInstance.addEventListener('message', handler);

        try {
            const response = await requester('original');
            expect(response).toEqual({ ok: true });
            expect((seenRequest as any)?.__blackiyaToken).toBe('bk:test-bridge-token');
        } finally {
            windowInstance.removeEventListener('message', handler);
        }
    });

    it('should ignore unstamped bridge responses and time out', async () => {
        const requester = createWindowJsonRequester(windowInstance as any, {
            requestType: 'BLACKIYA_GET_JSON_REQUEST',
            responseType: 'BLACKIYA_GET_JSON_RESPONSE',
            timeoutMs: 25,
            makeRequestId: () => 'request-2',
        });

        const handler = (event: any) => {
            const message = event.data as Record<string, unknown> | null;
            if (message?.type !== 'BLACKIYA_GET_JSON_REQUEST') {
                return;
            }
            // Missing __blackiyaToken should fail validation in requester.
            windowInstance.postMessage(
                {
                    type: 'BLACKIYA_GET_JSON_RESPONSE',
                    requestId: 'request-2',
                    success: true,
                    data: { ok: true },
                },
                windowInstance.location.origin,
            );
        };
        windowInstance.addEventListener('message', handler);

        try {
            await expect(requester('common')).rejects.toMatchObject({
                name: 'BlackiyaBridgeError',
                code: BRIDGE_ERROR_CODES.TIMEOUT,
            });
        } finally {
            windowInstance.removeEventListener('message', handler);
        }
    });

    it('should expose structured bridge error for failed responses', async () => {
        const requester = createWindowJsonRequester(windowInstance as any, {
            requestType: 'BLACKIYA_GET_JSON_REQUEST',
            responseType: 'BLACKIYA_GET_JSON_RESPONSE',
            timeoutMs: 100,
            makeRequestId: () => 'request-3',
        });

        const handler = (event: any) => {
            const message = event.data as Record<string, unknown> | null;
            if (message?.type !== 'BLACKIYA_GET_JSON_REQUEST') {
                return;
            }
            windowInstance.postMessage(
                {
                    type: 'BLACKIYA_GET_JSON_RESPONSE',
                    requestId: 'request-3',
                    success: false,
                    error: 'NOT_FOUND',
                    __blackiyaToken: 'bk:test-bridge-token',
                },
                windowInstance.location.origin,
            );
        };
        windowInstance.addEventListener('message', handler);

        try {
            try {
                await requester('common');
                expect.unreachable('expected requester to throw');
            } catch (error) {
                expect(error).toBeInstanceOf(BlackiyaBridgeError);
                const bridgeError = error as BlackiyaBridgeError;
                expect(bridgeError.code).toBe(BRIDGE_ERROR_CODES.NOT_FOUND);
                expect(bridgeError.details).toBe('NOT_FOUND');
            }
        } finally {
            windowInstance.removeEventListener('message', handler);
        }
    });
});
