import { buildCommonExport } from '@/utils/common-export';
import type {
    ExternalCommonConversationEvent,
    ExternalConversationEvent,
    ExternalConversationSuccessResponse,
    ExternalFailureResponse,
    ExternalOriginalConversationEvent,
    ExternalPullFormat,
    ExternalStoredConversationEvent,
} from '@/utils/external-api/contracts';
import { EXTERNAL_API_VERSION } from '@/utils/external-api/contracts';
import { EXPORT_FORMAT } from '@/utils/settings';

export const DEFAULT_BATCH_SIZE = 50;
export const MAX_BATCH_SIZE = 200;
export const DEFAULT_WAKE_THROTTLE_MS = 3_000;

export const clampBatchSize = (value: number | undefined, fallback: number) => {
    const normalizedFallback =
        typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0
            ? Math.floor(fallback)
            : DEFAULT_BATCH_SIZE;
    const candidate =
        typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : normalizedFallback;
    return Math.min(MAX_BATCH_SIZE, Math.max(1, candidate));
};

export const toFormat = (format: ExternalPullFormat | undefined): ExternalPullFormat =>
    format === EXPORT_FORMAT.COMMON ? EXPORT_FORMAT.COMMON : EXPORT_FORMAT.ORIGINAL;

const providerToPlatformName = (provider: ExternalConversationEvent['provider']): string => {
    if (provider === 'chatgpt') {
        return 'ChatGPT';
    }
    if (provider === 'gemini') {
        return 'Gemini';
    }
    if (provider === 'grok') {
        return 'Grok';
    }
    return 'Unknown';
};

export const buildFailureResponse = (
    now: () => number,
    code: ExternalFailureResponse['code'],
    message: string,
): ExternalFailureResponse => ({
    ok: false,
    api: EXTERNAL_API_VERSION,
    code,
    message,
    ts: now(),
});

export const buildSuccessResponse = (
    record: ExternalStoredConversationEvent,
    format: ExternalPullFormat,
    now: () => number,
): ExternalConversationSuccessResponse => {
    if (format === EXPORT_FORMAT.COMMON) {
        return {
            ok: true,
            api: EXTERNAL_API_VERSION,
            ts: now(),
            conversation_id: record.conversation_id,
            format: EXPORT_FORMAT.COMMON,
            data: buildCommonExport(record.payload, providerToPlatformName(record.provider)),
        };
    }

    return {
        ok: true,
        api: EXTERNAL_API_VERSION,
        ts: now(),
        conversation_id: record.conversation_id,
        format: EXPORT_FORMAT.ORIGINAL,
        data: record.payload,
    };
};

export function formatStoredEventForDelivery(
    record: ExternalStoredConversationEvent,
    format: typeof EXPORT_FORMAT.ORIGINAL,
): ExternalOriginalConversationEvent;
export function formatStoredEventForDelivery(
    record: ExternalStoredConversationEvent,
    format: typeof EXPORT_FORMAT.COMMON,
): ExternalCommonConversationEvent;
export function formatStoredEventForDelivery(
    record: ExternalStoredConversationEvent,
    format: ExternalPullFormat,
): ExternalConversationEvent;
export function formatStoredEventForDelivery(
    record: ExternalStoredConversationEvent,
    format: ExternalPullFormat,
): ExternalConversationEvent {
    if (format === EXPORT_FORMAT.COMMON) {
        return {
            ...record,
            format: EXPORT_FORMAT.COMMON,
            payload: buildCommonExport(record.payload, providerToPlatformName(record.provider)),
        } satisfies ExternalCommonConversationEvent;
    }

    if (record.format === EXPORT_FORMAT.ORIGINAL) {
        return record;
    }

    return {
        ...record,
        format: EXPORT_FORMAT.ORIGINAL,
    } satisfies ExternalOriginalConversationEvent;
}

export const asTabId = (value: number | undefined) =>
    typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
