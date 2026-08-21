import { describe, expect, it } from 'bun:test';
import {
    createV3StreamDebugBridge,
    V3_STREAM_DEBUG_MESSAGE_TYPES,
    type V3StreamDebugWindow,
} from '@/features/runtime/v3-stream-debug-bridge';

type TestMessageEvent = {
    data: unknown;
    origin: string;
    source: unknown;
};

const createWindow = () => {
    const listeners = new Set<(event: TestMessageEvent) => void>();
    const pageWindow = {};
    const windowLike: V3StreamDebugWindow = {
        location: { origin: 'https://chatgpt.com' },
        postMessage: (data, targetOrigin) => {
            if (targetOrigin !== 'https://chatgpt.com') {
                throw new Error(`Unexpected target origin: ${targetOrigin}`);
            }
            queueMicrotask(() => {
                const message = data as { type?: string; requestId?: string; __blackiyaToken?: string };
                if (message.type === V3_STREAM_DEBUG_MESSAGE_TYPES.EXPORT_REQUEST) {
                    for (const listener of listeners) {
                        listener({
                            data: {
                                type: V3_STREAM_DEBUG_MESSAGE_TYPES.EXPORT_RESPONSE,
                                requestId: message.requestId,
                                ok: true,
                                __blackiyaToken: message.__blackiyaToken,
                                records: [{ streamId: 'stream-1' }],
                            },
                            origin: 'https://chatgpt.com',
                            source: pageWindow,
                        });
                    }
                }
                if (message.type === V3_STREAM_DEBUG_MESSAGE_TYPES.CLEAR_REQUEST) {
                    for (const listener of listeners) {
                        listener({
                            data: {
                                type: V3_STREAM_DEBUG_MESSAGE_TYPES.CLEAR_RESPONSE,
                                requestId: message.requestId,
                                ok: true,
                                __blackiyaToken: message.__blackiyaToken,
                            },
                            origin: 'https://chatgpt.com',
                            source: pageWindow,
                        });
                    }
                }
            });
        },
        addEventListener: (_type, listener) => {
            listeners.add(listener);
        },
        removeEventListener: (_type, listener) => {
            listeners.delete(listener);
        },
        self: pageWindow,
    };

    return windowLike;
};

describe('v3 stream-debug bridge', () => {
    it('should request an explicit stream-debug export and ignore unrelated messages', async () => {
        const bridge = createV3StreamDebugBridge({
            window: createWindow(),
            timeoutMs: 100,
            createRequestId: () => 'request-1',
            token: 'test-token',
        });

        await expect(bridge.exportRecords()).resolves.toEqual([{ streamId: 'stream-1' }]);
        bridge.dispose();
    });

    it('should request clearing stream-debug records explicitly', async () => {
        const bridge = createV3StreamDebugBridge({
            window: createWindow(),
            timeoutMs: 100,
            createRequestId: () => 'request-2',
            token: 'test-token',
        });

        await expect(bridge.clearRecords()).resolves.toBeUndefined();
        bridge.dispose();
    });

    it('should reject when the page bridge does not respond', async () => {
        const windowLike = createWindow();
        windowLike.postMessage = () => undefined;
        const bridge = createV3StreamDebugBridge({
            window: windowLike,
            timeoutMs: 5,
            createRequestId: () => 'request-3',
            token: 'test-token',
        });

        await expect(bridge.exportRecords()).rejects.toThrow('Stream-debug bridge timed out.');
        bridge.dispose();
    });
});
