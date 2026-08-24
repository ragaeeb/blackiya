import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import {
    MAIN_WORLD_COMMAND_MESSAGE,
    MAIN_WORLD_PROGRESS_MESSAGE,
    MAIN_WORLD_RESULT_MESSAGE,
} from '@/features/runtime/main-world-command-contract';
import {
    isValidMainWorldMessageEvent,
    type MainWorldCommandOperations,
    setupMainWorldCommandHandler,
} from '@/features/runtime/main-world-command-handler';
import { getSessionToken, setSessionToken } from '@/utils/protocol/session-token';

describe('MAIN-world command handler', () => {
    let windowInstance: Window;
    let previousWindow: unknown;

    beforeEach(() => {
        previousWindow = (globalThis as Record<string, unknown>).window;
        windowInstance = new Window();
        (globalThis as any).window = windowInstance;
        setSessionToken('bk:main-world-command-handler');
    });

    afterEach(() => {
        const globalRecord = globalThis as Record<string, unknown>;
        if (previousWindow === undefined) {
            delete globalRecord.window;
        } else {
            globalRecord.window = previousWindow;
        }
    });

    it('should require the exact MAIN-world window and origin for commands', () => {
        const pageWindow = {};
        const commandWindow = {
            self: pageWindow,
            location: { origin: 'https://chatgpt.com' },
        };

        expect(
            isValidMainWorldMessageEvent(commandWindow, {
                data: {},
                source: pageWindow,
                origin: 'https://chatgpt.com',
            }),
        ).toBeTrue();
        expect(
            isValidMainWorldMessageEvent(commandWindow, {
                data: {},
                source: undefined,
                origin: 'https://chatgpt.com',
            }),
        ).toBeFalse();
        expect(
            isValidMainWorldMessageEvent(commandWindow, {
                data: {},
                source: null,
                origin: 'https://chatgpt.com',
            }),
        ).toBeFalse();
        expect(
            isValidMainWorldMessageEvent(commandWindow, {
                data: {},
                source: pageWindow,
                origin: undefined,
            }),
        ).toBeFalse();
        expect(
            isValidMainWorldMessageEvent(commandWindow, {
                data: {},
                source: pageWindow,
                origin: 'null',
            }),
        ).toBeFalse();
        expect(
            isValidMainWorldMessageEvent(commandWindow, {
                data: {},
                source: {},
                origin: 'https://chatgpt.com',
            }),
        ).toBeFalse();
        expect(
            isValidMainWorldMessageEvent(commandWindow, {
                data: {},
                source: pageWindow,
                origin: 'https://evil.example',
            }),
        ).toBeFalse();
    });

    const postCommand = (
        operation: string,
        requestId: string,
        options?: Record<string, unknown>,
        token = getSessionToken(),
        target?: { platform: string; conversationId: string },
    ) => {
        windowInstance.postMessage(
            {
                type: MAIN_WORLD_COMMAND_MESSAGE,
                operation,
                requestId,
                ...(options ? { options } : {}),
                ...(target ? { target } : {}),
                __blackiyaToken: token,
            },
            windowInstance.location.origin,
        );
    };

    it('should return only a safe single-export status summary', async () => {
        const operations: MainWorldCommandOperations = {
            singleExport: mock(async () => ({
                operation: 'single_export' as const,
                platform: 'ChatGPT',
                filename: 'conversation.json',
            })),
            bulkExport: mock(async () => ({
                operation: 'bulk_export' as const,
                platform: 'ChatGPT',
                discovered: 0,
                attempted: 0,
                exported: 0,
                failed: 0,
                elapsedMs: 1,
                limit: 0,
                warnings: [],
            })),
            exportStreamDebug: mock(async () => ({
                operation: 'stream_debug_export' as const,
                streamCount: 1,
                frameCount: 1,
                filename: 'debug.json',
            })),
            clearStreamDebug: mock(async () => ({ operation: 'stream_debug_clear' as const, clearedStreams: 1 })),
        };
        setupMainWorldCommandHandler({ window: windowInstance as never, operations });

        const response = new Promise<Record<string, unknown>>((resolve) => {
            windowInstance.addEventListener('message', ((event: MessageEvent) => {
                if ((event.data as Record<string, unknown>).type === MAIN_WORLD_RESULT_MESSAGE) {
                    resolve(event.data as Record<string, unknown>);
                }
            }) as any);
        });

        postCommand('single_export', 'single-1', undefined, getSessionToken(), {
            platform: 'ChatGPT',
            conversationId: 'conversation-a',
        });

        await expect(response).resolves.toEqual({
            type: MAIN_WORLD_RESULT_MESSAGE,
            requestId: 'single-1',
            operation: 'single_export',
            ok: true,
            result: {
                operation: 'single_export',
                platform: 'ChatGPT',
                filename: 'conversation.json',
            },
            __blackiyaToken: getSessionToken(),
        });
        expect(operations.singleExport).toHaveBeenCalledTimes(1);
        expect(operations.singleExport).toHaveBeenCalledWith({
            platform: 'ChatGPT',
            conversationId: 'conversation-a',
        });
    });

    it('should expose only typed bulk progress and completion summaries', async () => {
        const operations: MainWorldCommandOperations = {
            singleExport: mock(async () => ({
                operation: 'single_export' as const,
                platform: 'ChatGPT',
                filename: 'x.json',
            })),
            bulkExport: mock(async (_options, onProgress) => {
                onProgress({
                    stage: 'progress',
                    platform: 'ChatGPT',
                    discovered: 2,
                    attempted: 1,
                    exported: 1,
                    failed: 0,
                    remaining: 1,
                });
                return {
                    operation: 'bulk_export' as const,
                    platform: 'ChatGPT',
                    discovered: 2,
                    attempted: 2,
                    exported: 2,
                    failed: 0,
                    elapsedMs: 12,
                    limit: 0,
                    warnings: [],
                };
            }),
            exportStreamDebug: mock(async () => ({
                operation: 'stream_debug_export' as const,
                streamCount: 0,
                frameCount: 0,
                filename: 'x.json',
            })),
            clearStreamDebug: mock(async () => ({ operation: 'stream_debug_clear' as const, clearedStreams: 0 })),
        };
        setupMainWorldCommandHandler({ window: windowInstance as never, operations });

        const events: Record<string, unknown>[] = [];
        windowInstance.addEventListener('message', ((event: MessageEvent) => {
            const data = event.data as Record<string, unknown>;
            if (data.type === MAIN_WORLD_PROGRESS_MESSAGE || data.type === MAIN_WORLD_RESULT_MESSAGE) {
                events.push(data);
            }
        }) as any);

        postCommand('bulk_export', 'bulk-1', { limit: 0, delayMs: 0, timeoutMs: 1000 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({
            type: MAIN_WORLD_PROGRESS_MESSAGE,
            requestId: 'bulk-1',
            operation: 'bulk_export',
            stage: 'progress',
            attempted: 1,
            exported: 1,
        });
        expect(events[1]).toMatchObject({
            type: MAIN_WORLD_RESULT_MESSAGE,
            requestId: 'bulk-1',
            operation: 'bulk_export',
            ok: true,
            result: { exported: 2, attempted: 2 },
        });
        for (const event of events) {
            expect(event).not.toHaveProperty('headers');
            expect(event).not.toHaveProperty('context');
            expect(event).not.toHaveProperty('records');
            expect(event).not.toHaveProperty('frames');
            expect(event).not.toHaveProperty('text');
        }
    });

    it('should preserve typed error kinds without transferring error objects or payloads', async () => {
        const operations: MainWorldCommandOperations = {
            singleExport: mock(async () => {
                const error = new Error('Conversation is not ready to save.');
                (error as Error & { kind?: string }).kind = 'not_terminal';
                throw error;
            }),
            bulkExport: mock(async () => ({
                operation: 'bulk_export' as const,
                platform: 'ChatGPT',
                discovered: 0,
                attempted: 0,
                exported: 0,
                failed: 0,
                elapsedMs: 1,
                limit: 0,
                warnings: [],
            })),
            exportStreamDebug: mock(async () => ({
                operation: 'stream_debug_export' as const,
                streamCount: 0,
                frameCount: 0,
                filename: 'x.json',
            })),
            clearStreamDebug: mock(async () => ({ operation: 'stream_debug_clear' as const, clearedStreams: 0 })),
        };
        setupMainWorldCommandHandler({ window: windowInstance as never, operations });

        const response = new Promise<Record<string, unknown>>((resolve) => {
            windowInstance.addEventListener('message', ((event: MessageEvent) => {
                if ((event.data as Record<string, unknown>).type === MAIN_WORLD_RESULT_MESSAGE) {
                    resolve(event.data as Record<string, unknown>);
                }
            }) as any);
        });

        postCommand('single_export', 'single-error', undefined, getSessionToken(), {
            platform: 'ChatGPT',
            conversationId: 'conversation-a',
        });

        const resolved = await response;
        expect(resolved).toMatchObject({
            type: MAIN_WORLD_RESULT_MESSAGE,
            requestId: 'single-error',
            operation: 'single_export',
            ok: false,
            error: 'Conversation is not ready to save.',
            errorKind: 'not_terminal',
        });
        expect(resolved).not.toHaveProperty('errorObject');
    });

    it('should ignore commands with an invalid token', async () => {
        const operations: MainWorldCommandOperations = {
            singleExport: mock(async () => ({
                operation: 'single_export' as const,
                platform: 'ChatGPT',
                filename: 'x.json',
            })),
            bulkExport: mock(async () => ({
                operation: 'bulk_export' as const,
                platform: 'ChatGPT',
                discovered: 0,
                attempted: 0,
                exported: 0,
                failed: 0,
                elapsedMs: 1,
                limit: 0,
                warnings: [],
            })),
            exportStreamDebug: mock(async () => ({
                operation: 'stream_debug_export' as const,
                streamCount: 0,
                frameCount: 0,
                filename: 'x.json',
            })),
            clearStreamDebug: mock(async () => ({ operation: 'stream_debug_clear' as const, clearedStreams: 0 })),
        };
        setupMainWorldCommandHandler({ window: windowInstance as never, operations });

        postCommand('single_export', 'invalid-token', undefined, 'bk:wrong-token', {
            platform: 'ChatGPT',
            conversationId: 'conversation-a',
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(operations.singleExport).not.toHaveBeenCalled();
    });

    it('should reject unbound single-export commands before invoking MAIN operations', async () => {
        const operations: MainWorldCommandOperations = {
            singleExport: mock(async () => ({
                operation: 'single_export' as const,
                platform: 'ChatGPT',
                filename: 'x.json',
            })),
            bulkExport: mock(async () => ({
                operation: 'bulk_export' as const,
                platform: 'ChatGPT',
                discovered: 0,
                attempted: 0,
                exported: 0,
                failed: 0,
                elapsedMs: 1,
                limit: 0,
                warnings: [],
            })),
            exportStreamDebug: mock(async () => ({
                operation: 'stream_debug_export' as const,
                streamCount: 0,
                frameCount: 0,
                filename: 'x.json',
            })),
            clearStreamDebug: mock(async () => ({ operation: 'stream_debug_clear' as const, clearedStreams: 0 })),
        };
        setupMainWorldCommandHandler({ window: windowInstance as never, operations });

        postCommand('single_export', 'unbound-single');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(operations.singleExport).not.toHaveBeenCalled();
    });
});
