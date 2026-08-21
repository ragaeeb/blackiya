import { describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import {
    REQUEST_CONTEXT_INVALIDATION_MESSAGE,
    invalidateRequestContextInMainWorld,
} from '@/features/runtime/request-context-invalidation';
import { setSessionToken } from '@/utils/protocol/session-token';

describe('request-context invalidation bridge sender', () => {
    it('should post a token-stamped provider invalidation request', async () => {
        const windowInstance = new Window();
        const originalWindow = (globalThis as any).window;
        (globalThis as any).window = windowInstance;
        setSessionToken('bk:request-context-invalidation');

        try {
            const messagePromise = new Promise<Record<string, unknown>>((resolve) => {
                windowInstance.addEventListener('message', ((event: MessageEvent) => {
                    resolve(event.data as Record<string, unknown>);
                }) as any);
            });

            invalidateRequestContextInMainWorld('ChatGPT');

            await expect(messagePromise).resolves.toMatchObject({
                type: REQUEST_CONTEXT_INVALIDATION_MESSAGE,
                platformName: 'ChatGPT',
                __blackiyaToken: 'bk:request-context-invalidation',
            });
        } finally {
            (globalThis as any).window = originalWindow;
        }
    });
});
