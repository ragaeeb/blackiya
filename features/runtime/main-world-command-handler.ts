import type { BulkExportProgressMessage } from '@/features/bulk-export/contract';
import { sanitizeProgressError } from '@/features/bulk-export/progress';
import {
    isMainWorldCommandMessage,
    MAIN_WORLD_PROGRESS_MESSAGE,
    MAIN_WORLD_RESULT_MESSAGE,
    type MainWorldBulkExportSummary,
    type MainWorldCommandOperation,
    type MainWorldCommandSummary,
    type MainWorldSingleExportTarget,
} from '@/features/runtime/main-world-command-contract';
import { resolveTokenValidationFailureReason, stampToken } from '@/utils/protocol/session-token';

export type MainWorldCommandWindow = {
    location: { origin: string };
    self: unknown;
    postMessage: (data: unknown, targetOrigin: string) => void;
    addEventListener: (type: 'message', listener: (event: MainWorldMessageEvent) => void) => void;
    removeEventListener: (type: 'message', listener: (event: MainWorldMessageEvent) => void) => void;
};

export type MainWorldMessageEvent = {
    data: unknown;
    origin?: string;
    source?: unknown;
};

export type MainWorldCommandOperations = {
    singleExport: (target: MainWorldSingleExportTarget) => Promise<MainWorldCommandSummary>;
    bulkExport: (
        options: { limit: number; delayMs: number; timeoutMs: number },
        onProgress: (message: BulkExportProgressMessage) => void,
    ) => Promise<MainWorldBulkExportSummary>;
    exportStreamDebug: () => Promise<MainWorldCommandSummary>;
    clearStreamDebug: () => Promise<MainWorldCommandSummary>;
};

export const isValidMainWorldMessageEvent = (
    win: Pick<MainWorldCommandWindow, 'location' | 'self'>,
    event: MainWorldMessageEvent,
): boolean => event.source === win.self && event.origin === win.location.origin;

const post = (win: MainWorldCommandWindow, payload: Record<string, unknown>) => {
    win.postMessage(stampToken(payload), win.location.origin);
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const errorKind = (error: unknown): string | undefined => {
    const candidate = error as { kind?: unknown };
    return typeof candidate?.kind === 'string' && candidate.kind.length > 0 ? candidate.kind : undefined;
};

const postProgress = (win: MainWorldCommandWindow, requestId: string, progress: BulkExportProgressMessage) => {
    const { type: _progressType, ...safeProgress } = progress;
    post(win, {
        type: MAIN_WORLD_PROGRESS_MESSAGE,
        requestId,
        operation: 'bulk_export',
        ...safeProgress,
        platform: progress.platform ?? 'unknown',
    });
};

const executeOperation = (
    operation: MainWorldCommandOperation,
    options: { limit: number; delayMs: number; timeoutMs: number } | undefined,
    target: MainWorldSingleExportTarget | undefined,
    operations: MainWorldCommandOperations,
    onProgress: (message: BulkExportProgressMessage) => void,
): Promise<MainWorldCommandSummary> | undefined => {
    if (operation === 'bulk_export') {
        return options ? operations.bulkExport(options, onProgress) : undefined;
    }
    if (operation === 'single_export') {
        return target ? operations.singleExport(target) : undefined;
    }
    const handlers: Record<
        Exclude<MainWorldCommandOperation, 'bulk_export' | 'single_export'>,
        () => Promise<MainWorldCommandSummary>
    > = {
        stream_debug_export: operations.exportStreamDebug,
        stream_debug_clear: operations.clearStreamDebug,
    };
    return handlers[operation]();
};

export const setupMainWorldCommandHandler = ({
    window: win,
    operations,
}: {
    window: MainWorldCommandWindow;
    operations: MainWorldCommandOperations;
}) => {
    const handleMessage = (event: MainWorldMessageEvent) => {
        if (!isValidMainWorldMessageEvent(win, event)) {
            return;
        }
        if (!isMainWorldCommandMessage(event.data) || resolveTokenValidationFailureReason(event.data) !== null) {
            return;
        }

        const message = event.data;
        const finish = (payload: Record<string, unknown>) =>
            post(win, {
                type: MAIN_WORLD_RESULT_MESSAGE,
                requestId: message.requestId,
                operation: message.operation,
                ...payload,
            });

        const result = executeOperation(message.operation, message.options, message.target, operations, (progress) => {
            postProgress(win, message.requestId, progress);
        });
        if (!result) {
            return;
        }
        void result.then(
            (summary) => finish({ ok: true, result: summary }),
            (error) =>
                finish({
                    ok: false,
                    error: sanitizeProgressError(errorMessage(error)),
                    ...(errorKind(error) ? { errorKind: errorKind(error) } : {}),
                }),
        );
    };

    win.addEventListener('message', handleMessage);
    return () => win.removeEventListener('message', handleMessage);
};
