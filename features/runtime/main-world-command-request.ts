import {
    isMainWorldCommandResponse,
    isMainWorldProgressMessage,
    MAIN_WORLD_COMMAND_MESSAGE,
    type MainWorldCommandOperation,
    type MainWorldCommandSummary,
    type MainWorldProgressMessage,
} from '@/features/runtime/main-world-command-contract';

export type MainWorldCommandWindow = {
    location: { origin: string };
    self: unknown;
    postMessage: (data: unknown, targetOrigin: string) => void;
    addEventListener: (type: 'message', listener: (event: MainWorldMessageEvent) => void) => void;
    removeEventListener: (type: 'message', listener: (event: MainWorldMessageEvent) => void) => void;
};

type MainWorldMessageEvent = {
    data: unknown;
    origin: string;
    source: unknown;
};

export type MainWorldCommandBridgeDependencies = {
    window: MainWorldCommandWindow;
    token: string;
    timeoutMs?: number;
    createRequestId?: () => string;
};

export type MainWorldCommandBridge = {
    exportSingle: () => Promise<MainWorldCommandSummary>;
    runBulkExport: (
        options: { limit: number; delayMs: number; timeoutMs: number },
        onProgress?: (message: MainWorldProgressMessage) => void,
    ) => Promise<MainWorldCommandSummary>;
    exportStreamDebug: () => Promise<MainWorldCommandSummary>;
    clearStreamDebug: () => Promise<MainWorldCommandSummary>;
    dispose: () => void;
};

export class MainWorldCommandError extends Error {
    readonly kind?: string;

    constructor(message: string, kind?: string) {
        super(message);
        this.name = 'MainWorldCommandError';
        this.kind = kind;
    }
}

const defaultRequestId = () => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return crypto.randomUUID();
    }
    return `main-world-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const normalizeTimeout = (value: number | undefined) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 15_000;

const isAllowedEvent = (windowLike: MainWorldCommandWindow, event: MainWorldMessageEvent) =>
    event.source === windowLike.self && event.origin === windowLike.location.origin;

const matchesRequest = (
    data: { requestId: string; operation: MainWorldCommandOperation; __blackiyaToken?: string },
    requestId: string,
    operation: MainWorldCommandOperation,
    token: string,
) => data.requestId === requestId && data.operation === operation && data.__blackiyaToken === token;

const handleProgressMessage = (
    data: MainWorldProgressMessage,
    requestId: string,
    operation: MainWorldCommandOperation,
    token: string,
    onProgress: ((message: MainWorldProgressMessage) => void) | undefined,
) => {
    if (data.requestId === requestId && data.__blackiyaToken === token && operation === 'bulk_export') {
        onProgress?.(data);
    }
};

const handleCommandResponse = (
    data: unknown,
    requestId: string,
    operation: MainWorldCommandOperation,
    token: string,
    finish: (callback: () => void) => void,
    resolve: (summary: MainWorldCommandSummary) => void,
    reject: (error: MainWorldCommandError) => void,
) => {
    if (!isMainWorldCommandResponse(data) || !matchesRequest(data, requestId, operation, token)) {
        return;
    }
    if (data.ok) {
        finish(() => resolve(data.result));
    } else {
        finish(() => reject(new MainWorldCommandError(data.error, data.errorKind)));
    }
};

export const createMainWorldCommandBridge = ({
    window: windowLike,
    token,
    timeoutMs: configuredTimeoutMs,
    createRequestId = defaultRequestId,
}: MainWorldCommandBridgeDependencies): MainWorldCommandBridge => {
    const timeoutMs = normalizeTimeout(configuredTimeoutMs);
    const pendingCleanups = new Set<() => void>();

    const request = (
        operation: MainWorldCommandOperation,
        options?: { limit: number; delayMs: number; timeoutMs: number },
        onProgress?: (message: MainWorldProgressMessage) => void,
    ): Promise<MainWorldCommandSummary> =>
        new Promise((resolve, reject) => {
            const requestId = createRequestId();
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

            const cleanup = () => {
                windowLike.removeEventListener('message', handleMessage);
                if (timeoutHandle !== undefined) {
                    clearTimeout(timeoutHandle);
                }
                pendingCleanups.delete(cleanup);
            };

            const finish = (callback: () => void) => {
                cleanup();
                callback();
            };

            const handleMessage = (event: MainWorldMessageEvent) => {
                if (!isAllowedEvent(windowLike, event)) {
                    return;
                }
                const data = event.data;
                if (isMainWorldProgressMessage(data)) {
                    handleProgressMessage(data, requestId, operation, token, onProgress);
                    return;
                }
                handleCommandResponse(data, requestId, operation, token, finish, resolve, reject);
            };

            pendingCleanups.add(cleanup);
            windowLike.addEventListener('message', handleMessage);
            timeoutHandle = setTimeout(() => {
                finish(() => reject(new MainWorldCommandError('MAIN-world command timed out.')));
            }, timeoutMs);
            windowLike.postMessage(
                {
                    type: MAIN_WORLD_COMMAND_MESSAGE,
                    requestId,
                    operation,
                    ...(options ? { options } : {}),
                    __blackiyaToken: token,
                },
                windowLike.location.origin,
            );
        });

    return {
        exportSingle: () => request('single_export'),
        runBulkExport: (options, onProgress) => request('bulk_export', options, onProgress),
        exportStreamDebug: () => request('stream_debug_export'),
        clearStreamDebug: () => request('stream_debug_clear'),
        dispose: () => {
            for (const cleanup of Array.from(pendingCleanups)) {
                cleanup();
            }
        },
    };
};
