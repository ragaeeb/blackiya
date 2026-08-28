import { normalizeBulkExportLimitInput } from '@/entrypoints/popup/bulk-export-input';
import { DEFAULT_BULK_EXPORT_DELAY_MS, DEFAULT_BULK_EXPORT_TIMEOUT_MS } from '@/utils/settings';

export const V3_EXPORT_CHATS_MESSAGE = 'BLACKIYA_V3_EXPORT_CHATS';
export const V3_EXPORT_STREAM_DEBUG_MESSAGE = 'BLACKIYA_V3_EXPORT_STREAM_DEBUG';
export const V3_CLEAR_STREAM_DEBUG_MESSAGE = 'BLACKIYA_V3_CLEAR_STREAM_DEBUG';

export type V3ExportChatsMessage = {
    type: typeof V3_EXPORT_CHATS_MESSAGE;
    limit: number;
    delayMs: number;
    timeoutMs: number;
};

export type V3ExportStreamDebugMessage = {
    type: typeof V3_EXPORT_STREAM_DEBUG_MESSAGE;
};

export type V3ClearStreamDebugMessage = {
    type: typeof V3_CLEAR_STREAM_DEBUG_MESSAGE;
};

export type V3Message = V3ExportChatsMessage | V3ExportStreamDebugMessage | V3ClearStreamDebugMessage;

export type V3SuccessResponse = {
    ok: true;
    result?: unknown;
};

export type V3ErrorResponse = {
    ok: false;
    error: string;
};

export type V3Response = V3SuccessResponse | V3ErrorResponse;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

export const createExportChatsMessage = (limitInput: unknown): V3ExportChatsMessage => ({
    type: V3_EXPORT_CHATS_MESSAGE,
    limit: normalizeBulkExportLimitInput(limitInput),
    delayMs: DEFAULT_BULK_EXPORT_DELAY_MS,
    timeoutMs: DEFAULT_BULK_EXPORT_TIMEOUT_MS,
});

export const createExportStreamDebugMessage = (): V3ExportStreamDebugMessage => ({
    type: V3_EXPORT_STREAM_DEBUG_MESSAGE,
});

export const createClearStreamDebugMessage = (): V3ClearStreamDebugMessage => ({
    type: V3_CLEAR_STREAM_DEBUG_MESSAGE,
});

export const isV3SuccessResponse = (value: unknown): value is V3SuccessResponse => isRecord(value) && value.ok === true;

export const isV3ErrorResponse = (value: unknown): value is V3ErrorResponse =>
    isRecord(value) && value.ok === false && typeof value.error === 'string';

type BulkExportStatusInput = {
    platform?: string;
    attempted?: number;
    exported?: number;
    warnings?: string[];
};

const readBulkStatusInput = (result: unknown): BulkExportStatusInput | null => {
    if (!isRecord(result)) {
        return null;
    }
    return {
        platform: typeof result.platform === 'string' ? result.platform : undefined,
        attempted: typeof result.attempted === 'number' ? result.attempted : undefined,
        exported: typeof result.exported === 'number' ? result.exported : undefined,
        warnings: Array.isArray(result.warnings)
            ? result.warnings.filter((warning): warning is string => typeof warning === 'string')
            : undefined,
    };
};

export const formatBulkExportStatus = (result: unknown): string => {
    const status = readBulkStatusInput(result);
    if (!status || typeof status.exported !== 'number' || typeof status.attempted !== 'number') {
        return 'Export completed.';
    }
    const platform = status.platform ?? 'unknown';
    const base = `Exported ${status.exported}/${status.attempted} chats on ${platform}.`;
    const warnings = status.warnings ?? [];
    return warnings.length > 0 ? `${base} Warnings: ${warnings.join(' | ')}` : base;
};

export const formatStreamDebugExportedStatus = () => 'Stream debug exported.';

export const formatStreamDebugClearedStatus = () => 'Stream debug cleared.';
