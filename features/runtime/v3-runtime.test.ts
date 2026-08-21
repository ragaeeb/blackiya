import { describe, expect, it, mock } from 'bun:test';
import {
    createV3Runtime,
    type V3RuntimeDependencies,
    type V3RuntimeHost,
    V3_MESSAGE_TYPES,
} from '@/features/runtime/v3-runtime';

const createHost = () => {
    let listener: ((message: unknown) => Promise<unknown>) | null = null;
    const host: V3RuntimeHost = {
        onMessage: {
            addListener: mock((nextListener) => {
                listener = nextListener;
            }),
            removeListener: mock((nextListener) => {
                if (listener === nextListener) {
                    listener = null;
                }
            }),
        },
    };

    return {
        host,
        dispatch: async (message: unknown) => listener?.(message),
    };
};

const createDependencies = (): V3RuntimeDependencies => ({
    runBulkExport: mock(async (options) => ({
        exported: 1,
        attempted: options.limit === 0 ? 1 : options.limit,
    })),
    exportStreamDebug: mock(async () => ({
        schema: 'blackiya.stream-debug/v1',
        streams: 1,
    })),
    clearStreamDebug: mock(async () => undefined),
});

describe('v3 runtime', () => {
    it('should route bulk export requests to the bulk lane', async () => {
        const { host, dispatch } = createHost();
        const dependencies = createDependencies();
        const dispose = createV3Runtime(host, dependencies);

        const response = await dispatch({
            type: V3_MESSAGE_TYPES.EXPORT_CHATS,
            limit: 0,
            delayMs: 1500,
            timeoutMs: 30000,
        });

        expect(response).toEqual({ ok: true, result: { exported: 1, attempted: 1 } });
        expect(dependencies.runBulkExport).toHaveBeenCalledWith({
            limit: 0,
            delayMs: 1500,
            timeoutMs: 30000,
        });

        dispose();
        expect(host.onMessage.removeListener).toHaveBeenCalledTimes(1);
    });

    it('should export and clear stream-debug records through explicit requests', async () => {
        const { host, dispatch } = createHost();
        const dependencies = createDependencies();
        const dispose = createV3Runtime(host, dependencies);

        const exportResponse = await dispatch({ type: V3_MESSAGE_TYPES.EXPORT_STREAM_DEBUG });
        const clearResponse = await dispatch({ type: V3_MESSAGE_TYPES.CLEAR_STREAM_DEBUG });

        expect(exportResponse).toEqual({
            ok: true,
            result: { schema: 'blackiya.stream-debug/v1', streams: 1 },
        });
        expect(clearResponse).toEqual({ ok: true });
        expect(dependencies.exportStreamDebug).toHaveBeenCalledTimes(1);
        expect(dependencies.clearStreamDebug).toHaveBeenCalledTimes(1);

        dispose();
    });

    it('should fail closed for unknown and malformed messages', async () => {
        const { host, dispatch } = createHost();
        const dependencies = createDependencies();
        const dispose = createV3Runtime(host, dependencies);

        expect(await dispatch({ type: 'BLACKIYA_RESPONSE_LIFECYCLE', phase: 'completed' })).toEqual({
            ok: false,
            error: 'Unsupported v3 message.',
        });
        expect(await dispatch({ type: V3_MESSAGE_TYPES.EXPORT_CHATS, limit: -1 })).toEqual({
            ok: false,
            error: 'Invalid bulk export options.',
        });

        dispose();
    });

    it('should return typed errors when a retained lane fails', async () => {
        const { host, dispatch } = createHost();
        const dependencies = createDependencies();
        dependencies.exportStreamDebug = mock(async () => {
            throw new Error('No stream-debug records are available.');
        });
        const dispose = createV3Runtime(host, dependencies);

        expect(await dispatch({ type: V3_MESSAGE_TYPES.EXPORT_STREAM_DEBUG })).toEqual({
            ok: false,
            error: 'No stream-debug records are available.',
        });

        dispose();
    });
});
