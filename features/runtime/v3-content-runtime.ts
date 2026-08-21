import {
    createV3Runtime,
    type V3BulkExportOptions,
    type V3RuntimeHost,
} from '@/features/runtime/v3-runtime';
import {
    createMainWorldCommandBridge,
    type MainWorldCommandBridge,
    type MainWorldCommandBridgeDependencies,
    type MainWorldCommandWindow,
} from '@/features/runtime/main-world-command-request';
import type { MainWorldProgressMessage } from '@/features/runtime/main-world-command-contract';

export type V3ContentRuntimeHost = V3RuntimeHost;
export type V3ContentRuntimeWindow = MainWorldCommandWindow;

export type V3ContentRuntimeDependencies = {
    host: V3ContentRuntimeHost;
    window: V3ContentRuntimeWindow;
    sessionToken?: string;
    mainWorldBridge?: MainWorldCommandBridge;
    mainWorldTimeoutMs?: MainWorldCommandBridgeDependencies['timeoutMs'];
    createRequestId?: MainWorldCommandBridgeDependencies['createRequestId'];
    onBulkProgress?: (message: MainWorldProgressMessage) => void;
};

export const createV3ContentRuntime = ({
    host,
    window: windowLike,
    sessionToken,
    mainWorldBridge: providedBridge,
    mainWorldTimeoutMs,
    createRequestId,
    onBulkProgress,
}: V3ContentRuntimeDependencies) => {
    const mainWorldBridge = providedBridge ?? createMainWorldCommandBridge({
        window: windowLike,
        timeoutMs: mainWorldTimeoutMs,
        createRequestId,
        token: sessionToken ?? '',
    });
    const disposeRuntime = createV3Runtime(host, {
        runBulkExport: (options: V3BulkExportOptions) => mainWorldBridge.runBulkExport(options, onBulkProgress),
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
