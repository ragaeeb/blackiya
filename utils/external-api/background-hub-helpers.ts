import type {
    ExternalConversationEvent,
    ExternalConversationSuccessResponse,
    ExternalFailureResponse,
    ExternalStoredConversationEvent,
} from '@/utils/external-api/contracts';
import { EXTERNAL_API_VERSION } from '@/utils/external-api/contracts';

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
    now: () => number,
): ExternalConversationSuccessResponse => ({
    ok: true,
    api: EXTERNAL_API_VERSION,
    ts: now(),
    conversation_id: record.conversation_id,
    format: 'original',
    data: record.payload,
});

export const formatStoredEventForDelivery = (record: ExternalStoredConversationEvent): ExternalConversationEvent => record;

export const asTabId = (value: number | undefined) =>
    typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
