import { describe, expect, it, mock } from 'bun:test';
import {
    createV3ContentRuntime,
    type V3ContentRuntimeHost,
    type V3ContentRuntimeWindow,
} from '@/features/runtime/v3-content-runtime';
import { V3_MESSAGE_TYPES } from '@/features/runtime/v3-runtime';
import { V3_STREAM_DEBUG_MESSAGE_TYPES } from '@/features/runtime/v3-stream-debug-bridge';

const createHost = () => {
    let listener: ((message: unknown) => Promise<unknown>) | null = null;
    const host: V3ContentRuntimeHost = {
        onMessage: {
            addListener: mock((nextListener) => {
                listener = nextListener;
            }),
            removeListener: mock(() => {
                listener = null;
            }),
        },
    };

    return { host, dispatch: (message: unknown) => listener?.(message) };
};

const createWindow = (): V3ContentRuntimeWindow => {
    const pageWindow = {};
    const listeners = new Set<(event: { data: unknown; origin: string; source: unknown }) => void>();

    return {
        location: { origin: 'https://chatgpt.com' },
        self: pageWindow,
        addEventListener: (_type, listener) => listeners.add(listener),
        removeEventListener: (_type, listener) => listeners.delete(listener),
        postMessage: (data) => {
            const message = data as { type?: string; requestId?: string; __blackiyaToken?: string };
            const responseType =
                message.type === V3_STREAM_DEBUG_MESSAGE_TYPES.EXPORT_REQUEST
                    ? V3_STREAM_DEBUG_MESSAGE_TYPES.EXPORT_RESPONSE
                    : V3_STREAM_DEBUG_MESSAGE_TYPES.CLEAR_RESPONSE;
            queueMicrotask(() => {
                for (const listener of listeners) {
                    listener({
                        data: {
                            type: responseType,
                            requestId: message.requestId,
                            ok: true,
                            __blackiyaToken: message.__blackiyaToken,
                            records: message.type === V3_STREAM_DEBUG_MESSAGE_TYPES.EXPORT_REQUEST ? [] : undefined,
                        },
                        origin: 'https://chatgpt.com',
                        source: pageWindow,
                    });
                }
            });
        },
    };
};

describe('v3 content runtime', () => {
    it('should wire popup messages to bulk export and the explicit stream bridge', async () => {
        const { host, dispatch } = createHost();
        const runBulkExport = mock(async () => ({ exported: 2 }));
        const dispose = createV3ContentRuntime({
            host,
            window: createWindow(),
            runBulkExport,
            streamDebugTimeoutMs: 100,
            createRequestId: () => 'content-request-1',
            sessionToken: 'content-token',
        });

        await expect(
            dispatch({
                type: V3_MESSAGE_TYPES.EXPORT_CHATS,
                limit: 0,
                delayMs: 0,
                timeoutMs: 1000,
            }),
        ).resolves.toEqual({ ok: true, result: { exported: 2 } });
        await expect(dispatch({ type: V3_MESSAGE_TYPES.EXPORT_STREAM_DEBUG })).resolves.toEqual({
            ok: true,
            result: [],
        });

        expect(runBulkExport).toHaveBeenCalledTimes(1);
        dispose();
    });
});
