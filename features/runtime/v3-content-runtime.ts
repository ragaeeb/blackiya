import { BULK_EXPORT_PROGRESS_MESSAGE, type BulkExportProgressMessage } from '@/features/bulk-export/contract';
import type { MainWorldProgressMessage } from '@/features/runtime/main-world-command-contract';
import {
    createMainWorldCommandBridge,
    type MainWorldCommandBridge,
    type MainWorldCommandBridgeDependencies,
    type MainWorldCommandWindow,
} from '@/features/runtime/main-world-command-request';
import { createV3Runtime, type V3BulkExportOptions, type V3RuntimeHost } from '@/features/runtime/v3-runtime';

export type V3ContentRuntimeHost = V3RuntimeHost;
export type V3ContentRuntimeWindow = MainWorldCommandWindow;

export type V3ContentRuntimeDependencies = {
    host: V3ContentRuntimeHost;
    window: V3ContentRuntimeWindow;
    sessionToken?: string;
    mainWorldBridge?: MainWorldCommandBridge;
    mainWorldTimeoutMs?: MainWorldCommandBridgeDependencies['timeoutMs'];
    createRequestId?: MainWorldCommandBridgeDependencies['createRequestId'];
    onBulkProgress?: (message: BulkExportProgressMessage) => void;
};

const toBulkExportProgressMessage = ({
    type: _type,
    requestId: _requestId,
    operation: _operation,
    __blackiyaToken: _token,
    ...progress
}: MainWorldProgressMessage): BulkExportProgressMessage => ({
    type: BULK_EXPORT_PROGRESS_MESSAGE,
    ...progress,
});

export const createV3ContentRuntime = ({
    host,
    window: windowLike,
    sessionToken,
    mainWorldBridge: providedBridge,
    mainWorldTimeoutMs,
    createRequestId,
    onBulkProgress,
}: V3ContentRuntimeDependencies) => {
    const mainWorldBridge =
        providedBridge ??
        createMainWorldCommandBridge({
            window: windowLike,
            timeoutMs: mainWorldTimeoutMs,
            createRequestId,
            token: sessionToken ?? '',
        });
    const disposeRuntime = createV3Runtime(host, {
        runBulkExport: (options: V3BulkExportOptions) =>
            mainWorldBridge.runBulkExport(
                options,
                onBulkProgress ? (message) => onBulkProgress(toBulkExportProgressMessage(message)) : undefined,
            ),
        exportStreamDebug: mainWorldBridge.exportStreamDebug,
        clearStreamDebug: async () => {
            await mainWorldBridge.clearStreamDebug();
        },
    });

    return () => {
        disposeRuntime();
        mainWorldBridge.dispose();
    };
};
