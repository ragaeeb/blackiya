import {
    createV3Runtime,
    type V3BulkExportOptions,
    type V3RuntimeHost,
} from '@/features/runtime/v3-runtime';
import {
    createV3StreamDebugBridge,
    type V3StreamDebugBridgeDependencies,
    type V3StreamDebugWindow,
} from '@/features/runtime/v3-stream-debug-bridge';

export type V3ContentRuntimeHost = V3RuntimeHost;
export type V3ContentRuntimeWindow = V3StreamDebugWindow;

export type V3ContentRuntimeDependencies = {
    host: V3ContentRuntimeHost;
    window: V3ContentRuntimeWindow;
    runBulkExport: (options: V3BulkExportOptions) => Promise<unknown>;
    streamDebugTimeoutMs?: number;
    createRequestId?: V3StreamDebugBridgeDependencies['createRequestId'];
    sessionToken?: string;
};

export const createV3ContentRuntime = ({
    host,
    window: windowLike,
    runBulkExport,
    streamDebugTimeoutMs,
    createRequestId,
    sessionToken,
}: V3ContentRuntimeDependencies) => {
    const streamDebugBridge = createV3StreamDebugBridge({
        window: windowLike,
        timeoutMs: streamDebugTimeoutMs,
        createRequestId,
        token: sessionToken,
    });
    const disposeRuntime = createV3Runtime(host, {
        runBulkExport,
        exportStreamDebug: streamDebugBridge.exportRecords,
        clearStreamDebug: streamDebugBridge.clearRecords,
    });

    return () => {
        disposeRuntime();
        streamDebugBridge.dispose();
    };
};
