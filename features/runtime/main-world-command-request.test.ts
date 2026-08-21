import { describe, expect, it } from 'bun:test';
import {
    createMainWorldCommandBridge,
    type MainWorldCommandWindow,
} from '@/features/runtime/main-world-command-request';
import {
    MAIN_WORLD_COMMAND_MESSAGE,
    MAIN_WORLD_RESULT_MESSAGE,
} from '@/features/runtime/main-world-command-contract';

const createWindow = () => {
    const listeners = new Set<(event: { data: unknown; origin: string; source: unknown }) => void>();
    const pageWindow = {};
    const windowLike = {
        location: { origin: 'https://chatgpt.com' },
        self: pageWindow,
        postMessage: (data: unknown, targetOrigin: string) => {
            expect(targetOrigin).toBe('https://chatgpt.com');
            const message = data as Record<string, unknown>;
            expect(message.type).toBe(MAIN_WORLD_COMMAND_MESSAGE);
            expect(message).not.toHaveProperty('headers');
            expect(message).not.toHaveProperty('context');
            expect(message).not.toHaveProperty('records');
            expect(message).not.toHaveProperty('frames');
            expect(message).not.toHaveProperty('text');
            queueMicrotask(() => {
                for (const listener of listeners) {
                    listener({
                        data: {
                            type: MAIN_WORLD_RESULT_MESSAGE,
                            requestId: message.requestId,
                            operation: message.operation,
                            ok: true,
                            result:
                                message.operation === 'stream_debug_export'
                                    ? { operation: 'stream_debug_export', streamCount: 2, frameCount: 4, filename: 'debug.json' }
                                    : { operation: message.operation },
                            __blackiyaToken: 'test-token',
                        },
                        origin: 'https://chatgpt.com',
                        source: pageWindow,
                    });
                }
            });
        },
        addEventListener: (_type: 'message', listener: (event: { data: unknown; origin: string; source: unknown }) => void) =>
            listeners.add(listener),
        removeEventListener: (_type: 'message', listener: (event: { data: unknown; origin: string; source: unknown }) => void) =>
            listeners.delete(listener),
    } as unknown as MainWorldCommandWindow & {
        __listeners: Set<(event: { data: unknown; origin: string; source: unknown }) => void>;
    };
    windowLike.__listeners = listeners;
    return windowLike;
};

describe('isolated MAIN-world command requester', () => {
    it('should resolve a safe stream-debug download summary instead of records', async () => {
        const bridge = createMainWorldCommandBridge({
            window: createWindow(),
            token: 'test-token',
            timeoutMs: 100,
            createRequestId: () => 'request-1',
        });

        await expect(bridge.exportStreamDebug()).resolves.toEqual({
            operation: 'stream_debug_export',
            streamCount: 2,
            frameCount: 4,
            filename: 'debug.json',
        });
        bridge.dispose();
    });

    it('should preserve typed command errors as isolated-side Error metadata', async () => {
        const windowLike = createWindow();
        windowLike.postMessage = (data) => {
            const message = data as Record<string, unknown>;
            queueMicrotask(() => {
                for (const listener of listenersFor(windowLike)) {
                    listener({
                        data: {
                            type: MAIN_WORLD_RESULT_MESSAGE,
                            requestId: message.requestId,
                            operation: message.operation,
                            ok: false,
                            error: 'Conversation is not ready to save.',
                            errorKind: 'not_terminal',
                            __blackiyaToken: 'test-token',
                        },
                        origin: windowLike.location.origin,
                        source: windowLike.self,
                    });
                }
            });
        };

        const bridge = createMainWorldCommandBridge({
            window: windowLike,
            token: 'test-token',
            timeoutMs: 100,
            createRequestId: () => 'request-2',
        });

        await expect(bridge.exportSingle()).rejects.toMatchObject({ message: 'Conversation is not ready to save.', kind: 'not_terminal' });
        bridge.dispose();
    });

    it('should ignore a forged response that attempts to carry stream records', async () => {
        const windowLike = createWindow();
        windowLike.postMessage = (data: unknown) => {
            const message = data as Record<string, unknown>;
            queueMicrotask(() => {
                for (const listener of listenersFor(windowLike)) {
                    listener({
                        data: {
                            type: MAIN_WORLD_RESULT_MESSAGE,
                            requestId: message.requestId,
                            operation: message.operation,
                            ok: true,
                            result: {
                                operation: 'stream_debug_export',
                                streamCount: 1,
                                frameCount: 1,
                                filename: 'debug.json',
                                records: [{ frames: [{ text: 'secret' }] }],
                            },
                            __blackiyaToken: 'test-token',
                        },
                        origin: windowLike.location.origin,
                        source: windowLike.self,
                    });
                }
            });
        };

        const bridge = createMainWorldCommandBridge({
            window: windowLike,
            token: 'test-token',
            timeoutMs: 5,
            createRequestId: () => 'request-forged',
        });

        await expect(bridge.exportStreamDebug()).rejects.toThrow('MAIN-world command timed out.');
        bridge.dispose();
    });
});

const listenersFor = (windowLike: MainWorldCommandWindow) => {
    const listeners = (windowLike as MainWorldCommandWindow & { __listeners?: Set<any> }).__listeners;
    if (!listeners) {
        throw new Error('Test window does not expose listeners.');
    }
    return listeners;
};
