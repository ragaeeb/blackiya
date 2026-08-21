import type { BulkExportProgressStage } from '@/features/bulk-export/contract';
import type { V3BulkExportOptions } from '@/features/runtime/v3-runtime';

export const MAIN_WORLD_COMMAND_MESSAGE = 'BLACKIYA_MAIN_WORLD_COMMAND';
export const MAIN_WORLD_RESULT_MESSAGE = 'BLACKIYA_MAIN_WORLD_RESULT';
export const MAIN_WORLD_PROGRESS_MESSAGE = 'BLACKIYA_MAIN_WORLD_PROGRESS';

export type MainWorldCommandOperation =
    | 'single_export'
    | 'bulk_export'
    | 'stream_debug_export'
    | 'stream_debug_clear';

export type MainWorldCommandMessage = {
    type: typeof MAIN_WORLD_COMMAND_MESSAGE;
    requestId: string;
    operation: MainWorldCommandOperation;
    options?: V3BulkExportOptions;
    __blackiyaToken?: string;
};

export type MainWorldSingleExportSummary = {
    operation: 'single_export';
    platform: string;
    filename: string;
};

export type MainWorldBulkExportSummary = {
    operation: 'bulk_export';
    platform: string;
    discovered: number;
    attempted: number;
    exported: number;
    failed: number;
    elapsedMs: number;
    limit: number;
    warnings: string[];
};

export type MainWorldStreamDebugExportSummary = {
    operation: 'stream_debug_export';
    streamCount: number;
    frameCount: number;
    filename: string;
};

export type MainWorldStreamDebugClearSummary = {
    operation: 'stream_debug_clear';
    clearedStreams: number;
};

export type MainWorldCommandSummary =
    | MainWorldSingleExportSummary
    | MainWorldBulkExportSummary
    | MainWorldStreamDebugExportSummary
    | MainWorldStreamDebugClearSummary;

export type MainWorldCommandSuccess = {
    type: typeof MAIN_WORLD_RESULT_MESSAGE;
    requestId: string;
    operation: MainWorldCommandOperation;
    ok: true;
    result: MainWorldCommandSummary;
    __blackiyaToken?: string;
};

export type MainWorldCommandFailure = {
    type: typeof MAIN_WORLD_RESULT_MESSAGE;
    requestId: string;
    operation: MainWorldCommandOperation;
    ok: false;
    error: string;
    errorKind?: string;
    __blackiyaToken?: string;
};

export type MainWorldCommandResponse = MainWorldCommandSuccess | MainWorldCommandFailure;

export type MainWorldProgressMessage = {
    type: typeof MAIN_WORLD_PROGRESS_MESSAGE;
    requestId: string;
    operation: 'bulk_export';
    stage: BulkExportProgressStage;
    platform: string;
    discovered?: number;
    attempted?: number;
    exported?: number;
    failed?: number;
    remaining?: number;
    message?: string;
    __blackiyaToken?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

const isOperation = (value: unknown): value is MainWorldCommandOperation =>
    value === 'single_export' ||
    value === 'bulk_export' ||
    value === 'stream_debug_export' ||
    value === 'stream_debug_clear';

const isFiniteNonNegativeNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;

const containsSensitiveField = (value: Record<string, unknown>): boolean =>
    ['authorization', 'headers', 'context', 'at', 'body', 'data', 'records', 'frames', 'text', 'jsonString'].some(
        (key) => key in value,
    );

const isBulkOptions = (value: unknown): value is V3BulkExportOptions => {
    if (!isRecord(value)) {
        return false;
    }
    return (
        typeof value.limit === 'number' &&
        Number.isInteger(value.limit) &&
        value.limit >= 0 &&
        isFiniteNonNegativeNumber(value.delayMs) &&
        isFiniteNonNegativeNumber(value.timeoutMs)
    );
};

export const isMainWorldCommandMessage = (value: unknown): value is MainWorldCommandMessage => {
    if (!isRecord(value) || value.type !== MAIN_WORLD_COMMAND_MESSAGE) {
        return false;
    }
    if (containsSensitiveField(value)) {
        return false;
    }
    if (typeof value.requestId !== 'string' || value.requestId.length === 0 || !isOperation(value.operation)) {
        return false;
    }
    if (value.operation === 'bulk_export') {
        return isBulkOptions(value.options);
    }
    return value.options === undefined;
};

const isSummary = (value: unknown): value is MainWorldCommandSummary => {
    if (!isRecord(value) || typeof value.operation !== 'string') {
        return false;
    }
    if (containsSensitiveField(value)) {
        return false;
    }
    if (value.operation === 'single_export') {
        return typeof value.platform === 'string' && typeof value.filename === 'string';
    }
    if (value.operation === 'bulk_export') {
        return (
            typeof value.platform === 'string' &&
            isFiniteNonNegativeNumber(value.discovered) &&
            isFiniteNonNegativeNumber(value.attempted) &&
            isFiniteNonNegativeNumber(value.exported) &&
            isFiniteNonNegativeNumber(value.failed) &&
            isFiniteNonNegativeNumber(value.elapsedMs) &&
            isFiniteNonNegativeNumber(value.limit) &&
            Array.isArray(value.warnings) &&
            value.warnings.every((warning) => typeof warning === 'string')
        );
    }
    if (value.operation === 'stream_debug_export') {
        return (
            isFiniteNonNegativeNumber(value.streamCount) &&
            isFiniteNonNegativeNumber(value.frameCount) &&
            typeof value.filename === 'string'
        );
    }
    return value.operation === 'stream_debug_clear' && isFiniteNonNegativeNumber(value.clearedStreams);
};

export const isMainWorldCommandResponse = (value: unknown): value is MainWorldCommandResponse => {
    if (!isRecord(value) || value.type !== MAIN_WORLD_RESULT_MESSAGE) {
        return false;
    }
    if (containsSensitiveField(value)) {
        return false;
    }
    if (typeof value.requestId !== 'string' || value.requestId.length === 0 || !isOperation(value.operation)) {
        return false;
    }
    if (value.ok === true) {
        return isSummary(value.result) && value.result.operation === value.operation;
    }
    return value.ok === false && typeof value.error === 'string' && value.error.length > 0;
};

export const isMainWorldProgressMessage = (value: unknown): value is MainWorldProgressMessage => {
    if (!isRecord(value) || value.type !== MAIN_WORLD_PROGRESS_MESSAGE) {
        return false;
    }
    if (
        typeof value.requestId !== 'string' ||
        value.requestId.length === 0 ||
        value.operation !== 'bulk_export' ||
        typeof value.platform !== 'string' ||
        !['started', 'progress', 'completed', 'failed'].includes(value.stage as string)
    ) {
        return false;
    }
    return ['discovered', 'attempted', 'exported', 'failed', 'remaining'].every((key) => {
        const candidate = value[key];
        return candidate === undefined || isFiniteNonNegativeNumber(candidate);
    }) && (value.message === undefined || typeof value.message === 'string');
};
