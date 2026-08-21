import { describe, expect, it, mock } from 'bun:test';
import {
    createV3ContentRuntime,
    type V3ContentRuntimeHost,
    type V3ContentRuntimeWindow,
} from '@/features/runtime/v3-content-runtime';
import { V3_MESSAGE_TYPES } from '@/features/runtime/v3-runtime';

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
        postMessage: () => undefined,
    };
};

describe('v3 content runtime', () => {
    it('should wire popup messages to MAIN-world export commands', async () => {
        const { host, dispatch } = createHost();
        const mainWorldBridge = {
            exportSingle: mock(async () => ({ operation: 'single_export' as const, platform: 'ChatGPT', filename: 'x.json' })),
            runBulkExport: mock(async () => ({ operation: 'bulk_export' as const, platform: 'ChatGPT', discovered: 2, attempted: 2, exported: 2, failed: 0, elapsedMs: 1, limit: 0, warnings: [] })),
            exportStreamDebug: mock(async () => ({ operation: 'stream_debug_export' as const, streamCount: 0, frameCount: 0, filename: 'x.json' })),
            clearStreamDebug: mock(async () => ({ operation: 'stream_debug_clear' as const, clearedStreams: 0 })),
            dispose: mock(() => undefined),
        };
        const dispose = createV3ContentRuntime({
            host,
            window: createWindow(),
            sessionToken: 'content-token',
            mainWorldBridge,
        });

        await expect(
            dispatch({
                type: V3_MESSAGE_TYPES.EXPORT_CHATS,
                limit: 0,
                delayMs: 0,
                timeoutMs: 1000,
            }),
        ).resolves.toEqual({
            ok: true,
            result: {
                operation: 'bulk_export',
                platform: 'ChatGPT',
                discovered: 2,
                attempted: 2,
                exported: 2,
                failed: 0,
                elapsedMs: 1,
                limit: 0,
                warnings: [],
            },
        });
        await expect(dispatch({ type: V3_MESSAGE_TYPES.EXPORT_STREAM_DEBUG })).resolves.toEqual({
            ok: true,
            result: { operation: 'stream_debug_export', streamCount: 0, frameCount: 0, filename: 'x.json' },
        });

        expect(mainWorldBridge.runBulkExport).toHaveBeenCalledTimes(1);
        dispose();
    });
});
