import { describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import { createWindowJsonRequester } from '@/entrypoints/interceptor/snapshot-bridge';

describe('snapshot bridge requester', () => {
    it('resolves when response message returns success', async () => {
        const testWindow = new Window();
        const requester = createWindowJsonRequester(testWindow as unknown as any, {
            requestType: 'BLACKIYA_GET_JSON_REQUEST',
            responseType: 'BLACKIYA_GET_JSON_RESPONSE',
            timeoutMs: 200,
            makeRequestId: () => 'req-1',
        });

        testWindow.addEventListener('message', (event: any) => {
            const message = event.data as { type?: string; requestId?: string };
            if (message?.type !== 'BLACKIYA_GET_JSON_REQUEST' || message.requestId !== 'req-1') {
                return;
            }
            testWindow.postMessage(
                {
                    type: 'BLACKIYA_GET_JSON_RESPONSE',
                    requestId: 'req-1',
                    success: true,
                    data: { ok: true },
                },
                testWindow.location.origin,
            );
        });

        await expect(requester('original')).resolves.toEqual({ ok: true });
    });

    it('rejects when no response arrives before timeout', async () => {
        const testWindow = new Window();
        const requester = createWindowJsonRequester(testWindow as unknown as any, {
            requestType: 'BLACKIYA_GET_JSON_REQUEST',
            responseType: 'BLACKIYA_GET_JSON_RESPONSE',
            timeoutMs: 20,
            makeRequestId: () => 'req-timeout',
        });
        await expect(requester('common')).rejects.toThrow('TIMEOUT');
    });
});
