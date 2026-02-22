import type { CommonConversationExport } from '@/utils/common-export';
import type { ExportMeta } from '@/utils/sfe/types';
import { hasString, isFiniteNumber, isNullableString, isRecord } from '@/utils/type-guards';
import type { ConversationData } from '@/utils/types';

export const EXTERNAL_API_VERSION = 'blackiya.events.v1';
export const EXTERNAL_EVENTS_PORT_NAME = EXTERNAL_API_VERSION;
export const EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE = 'BLACKIYA_EXTERNAL_EVENT';

export type ExternalApiVersion = typeof EXTERNAL_API_VERSION;
export type ExternalProvider = 'chatgpt' | 'gemini' | 'grok' | 'unknown';
export type ExternalPushEventType = 'conversation.ready' | 'conversation.updated';
export type ExternalPullFormat = 'original' | 'common';

export type ExternalConversationEvent = {
    api: ExternalApiVersion;
    type: ExternalPushEventType;
    event_id: string;
    ts: number;
    provider: ExternalProvider;
    tab_id?: number;
    conversation_id: string;
    payload: ConversationData;
    attempt_id?: string | null;
    capture_meta: ExportMeta;
    content_hash: string | null;
};

export type ExternalGetLatestRequest = {
    api: ExternalApiVersion;
    type: 'conversation.getLatest';
    tab_id?: number;
    format?: ExternalPullFormat;
};

export type ExternalGetByIdRequest = {
    api: ExternalApiVersion;
    type: 'conversation.getById';
    conversation_id: string;
    format?: ExternalPullFormat;
};

export type ExternalHealthPingRequest = {
    api: ExternalApiVersion;
    type: 'health.ping';
};

export type ExternalRequest = ExternalGetLatestRequest | ExternalGetByIdRequest | ExternalHealthPingRequest;

export type ExternalHealthSuccessResponse = {
    ok: true;
    api: ExternalApiVersion;
    ts: number;
};

export type ExternalConversationSuccessResponse =
    | {
          ok: true;
          api: ExternalApiVersion;
          ts: number;
          conversation_id: string;
          format: 'original';
          data: ConversationData;
      }
    | {
          ok: true;
          api: ExternalApiVersion;
          ts: number;
          conversation_id: string;
          format: 'common';
          data: CommonConversationExport;
      };

export type ExternalSuccessResponse = ExternalHealthSuccessResponse | ExternalConversationSuccessResponse;

export type ExternalFailureResponse = {
    ok: false;
    api: ExternalApiVersion;
    ts: number;
    code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'UNAVAILABLE' | 'INTERNAL_ERROR';
    message: string;
};

export type ExternalResponse = ExternalSuccessResponse | ExternalFailureResponse;

export type ExternalInternalEventMessage = {
    type: typeof EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE;
    event: ExternalConversationEvent;
};

const isExternalApiVersion = (value: unknown): value is ExternalApiVersion => value === EXTERNAL_API_VERSION;

const isExternalProvider = (value: unknown): value is ExternalProvider =>
    value === 'chatgpt' || value === 'gemini' || value === 'grok' || value === 'unknown';

const isExternalPushEventType = (value: unknown): value is ExternalPushEventType =>
    value === 'conversation.ready' || value === 'conversation.updated';

const isExternalPullFormat = (value: unknown): value is ExternalPullFormat =>
    value === 'original' || value === 'common';

export const isExportMeta = (value: unknown): value is ExportMeta => {
    if (!isRecord(value)) {
        return false;
    }
    return (
        (value.captureSource === 'canonical_api' || value.captureSource === 'dom_snapshot_degraded') &&
        (value.fidelity === 'high' || value.fidelity === 'degraded') &&
        (value.completeness === 'complete' || value.completeness === 'partial')
    );
};

const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

export const isConversationDataLike = (value: unknown): value is ConversationData => {
    if (!isRecord(value)) {
        return false;
    }
    return (
        hasString(value.title) &&
        isFiniteNumber(value.create_time) &&
        isFiniteNumber(value.update_time) &&
        isRecord(value.mapping) &&
        hasString(value.conversation_id) &&
        hasString(value.current_node) &&
        Array.isArray(value.moderation_results) &&
        (value.plugin_ids === null || isStringArray(value.plugin_ids)) &&
        isNullableString(value.gizmo_id) &&
        isNullableString(value.gizmo_type) &&
        typeof value.is_archived === 'boolean' &&
        hasString(value.default_model_slug) &&
        isStringArray(value.safe_urls) &&
        isStringArray(value.blocked_urls)
    );
};

export const isExternalConversationEvent = (value: unknown): value is ExternalConversationEvent => {
    if (!isRecord(value)) {
        return false;
    }
    return (
        isExternalApiVersion(value.api) &&
        isExternalPushEventType(value.type) &&
        hasString(value.event_id) &&
        isFiniteNumber(value.ts) &&
        isExternalProvider(value.provider) &&
        (value.tab_id === undefined || isFiniteNumber(value.tab_id)) &&
        hasString(value.conversation_id) &&
        isConversationDataLike(value.payload) &&
        (value.attempt_id === undefined || isNullableString(value.attempt_id)) &&
        isExportMeta(value.capture_meta) &&
        isNullableString(value.content_hash)
    );
};

export const isExternalInternalEventMessage = (value: unknown): value is ExternalInternalEventMessage => {
    if (!isRecord(value)) {
        return false;
    }
    return value.type === EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE && isExternalConversationEvent(value.event);
};

const isExternalGetLatestRequest = (value: Record<string, unknown>): value is ExternalGetLatestRequest => {
    if (value.type !== 'conversation.getLatest') {
        return false;
    }
    return (
        (value.tab_id === undefined || isFiniteNumber(value.tab_id)) &&
        (value.format === undefined || isExternalPullFormat(value.format))
    );
};

const isExternalGetByIdRequest = (value: Record<string, unknown>): value is ExternalGetByIdRequest => {
    if (value.type !== 'conversation.getById') {
        return false;
    }
    return hasString(value.conversation_id) && (value.format === undefined || isExternalPullFormat(value.format));
};

const isExternalHealthPingRequest = (value: Record<string, unknown>): value is ExternalHealthPingRequest =>
    value.type === 'health.ping';

export const isExternalRequest = (value: unknown): value is ExternalRequest => {
    if (!isRecord(value) || !isExternalApiVersion(value.api)) {
        return false;
    }
    return isExternalGetLatestRequest(value) || isExternalGetByIdRequest(value) || isExternalHealthPingRequest(value);
};

export const normalizeExternalProvider = (platformName: string | null | undefined): ExternalProvider => {
    const lower = (platformName ?? '').trim().toLowerCase();
    if (lower === 'chatgpt') {
        return 'chatgpt';
    }
    if (lower === 'gemini') {
        return 'gemini';
    }
    if (lower === 'grok') {
        return 'grok';
    }
    return 'unknown';
};
