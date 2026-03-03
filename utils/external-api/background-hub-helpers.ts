import { buildCommonExport } from '@/utils/common-export';
import type {
    ExternalConversationEvent,
    ExternalConversationSuccessResponse,
    ExternalFailureResponse,
    ExternalPullFormat,
} from '@/utils/external-api/contracts';
import { EXTERNAL_API_VERSION } from '@/utils/external-api/contracts';
import { EXPORT_FORMAT } from '@/utils/settings';

export const DEFAULT_BATCH_SIZE = 50;
export const MAX_BATCH_SIZE = 200;
export const DEFAULT_WAKE_THROTTLE_MS = 3_000;

export const clampBatchSize = (value: number | undefined, fallback: number) => {
    if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
        return fallback;
    }
    return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(value)));
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
    record: ExternalConversationEvent,
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

export const asTabId = (value: number | undefined) => (typeof value === 'number' ? value : undefined);
