export const BULK_EXPORT_CHATS_MESSAGE = 'BLACKIYA_BULK_EXPORT_CHATS';
export const BULK_EXPORT_PROGRESS_MESSAGE = 'BLACKIYA_BULK_EXPORT_PROGRESS';

export type BulkExportChatsMessage = {
    type: typeof BULK_EXPORT_CHATS_MESSAGE;
    limit?: number;
    delayMs?: number;
    timeoutMs?: number;
};

export type BulkExportChatsSuccessResponse = {
    ok: true;
    result: {
        platform: string;
        discovered: number;
        attempted: number;
        exported: number;
        failed: number;
        elapsedMs: number;
        limit: number;
        warnings: string[];
    };
};

export type BulkExportChatsErrorResponse = {
    ok: false;
    error: string;
};

export type BulkExportChatsResponse = BulkExportChatsSuccessResponse | BulkExportChatsErrorResponse;

export type BulkExportProgressStage = 'started' | 'progress' | 'completed' | 'failed';

export type BulkExportProgressMessage = {
    type: typeof BULK_EXPORT_PROGRESS_MESSAGE;
    stage: BulkExportProgressStage;
    platform?: string;
    discovered?: number;
    attempted?: number;
    exported?: number;
    failed?: number;
    remaining?: number;
    message?: string;
};

const isOptionalFiniteNumber = (value: unknown): value is number =>
    value === undefined || (typeof value === 'number' && Number.isFinite(value));

export const isBulkExportChatsMessage = (value: unknown): value is BulkExportChatsMessage => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const typed = value as Partial<BulkExportChatsMessage>;
    return (
        typed.type === BULK_EXPORT_CHATS_MESSAGE &&
        isOptionalFiniteNumber(typed.limit) &&
        isOptionalFiniteNumber(typed.delayMs) &&
        isOptionalFiniteNumber(typed.timeoutMs)
    );
};

const isProgressStage = (value: unknown): value is BulkExportProgressStage =>
    value === 'started' || value === 'progress' || value === 'completed' || value === 'failed';

export const isBulkExportProgressMessage = (value: unknown): value is BulkExportProgressMessage => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const typed = value as Partial<BulkExportProgressMessage>;
    return (
        typed.type === BULK_EXPORT_PROGRESS_MESSAGE &&
        isProgressStage(typed.stage) &&
        (typed.platform === undefined || typeof typed.platform === 'string') &&
        isOptionalFiniteNumber(typed.discovered) &&
        isOptionalFiniteNumber(typed.attempted) &&
        isOptionalFiniteNumber(typed.exported) &&
        isOptionalFiniteNumber(typed.failed) &&
        isOptionalFiniteNumber(typed.remaining) &&
        (typed.message === undefined || typeof typed.message === 'string')
    );
};
