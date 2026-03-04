import type { CommonConversationExport } from '@/utils/common-export';
import { EXPORT_FORMAT, type ExportFormat } from '@/utils/settings';
import type { ExportMeta } from '@/utils/sfe/types';
import { hasString, isFiniteNumber, isNullableString, isRecord } from '@/utils/type-guards';
import type { ConversationData } from '@/utils/types';

export const EXTERNAL_API_VERSION = 'blackiya.events.v1';
export const EXTERNAL_EVENTS_PORT_NAME = EXTERNAL_API_VERSION;
export const EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE = 'BLACKIYA_EXTERNAL_EVENT';
export const EXTERNAL_PUSH_EVENT_TYPES = ['conversation.ready', 'conversation.updated'] as const;

export type ExternalApiVersion = typeof EXTERNAL_API_VERSION;
export type ExternalProvider = 'chatgpt' | 'gemini' | 'grok' | 'unknown';
export type ExternalPushEventType = (typeof EXTERNAL_PUSH_EVENT_TYPES)[number];
export type ExternalPullFormat = ExportFormat;

type ExternalConversationEventBase = {
    api: ExternalApiVersion;
    type: ExternalPushEventType;
    event_id: string;
    seq: number;
    created_at: number;
    ts: number;
    format: ExternalPullFormat;
    provider: ExternalProvider;
    tab_id?: number;
    conversation_id: string;
    attempt_id?: string | null;
    capture_meta: ExportMeta;
    content_hash: string | null;
};

export type ExternalOriginalConversationEvent = ExternalConversationEventBase & {
    format: typeof EXPORT_FORMAT.ORIGINAL;
    payload: ConversationData;
};

export type ExternalCommonConversationEvent = ExternalConversationEventBase & {
    format: typeof EXPORT_FORMAT.COMMON;
    payload: CommonConversationExport;
};

export type ExternalConversationEvent = ExternalOriginalConversationEvent | ExternalCommonConversationEvent;
export type ExternalStoredConversationEvent = ExternalOriginalConversationEvent;

export type ExternalInboundConversationEvent = Omit<
    ExternalOriginalConversationEvent,
    'seq' | 'created_at' | 'format'
> & {
    seq?: number;
    created_at?: number;
    format?: typeof EXPORT_FORMAT.ORIGINAL;
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

export type ExternalGetSinceRequest = {
    api: ExternalApiVersion;
    type: 'events.getSince';
    cursor: number;
    limit?: number;
    format?: ExternalPullFormat;
};

export type ExternalHealthPingRequest = {
    api: ExternalApiVersion;
    type: 'health.ping';
};

export type ExternalRequest =
    | ExternalGetLatestRequest
    | ExternalGetByIdRequest
    | ExternalGetSinceRequest
    | ExternalHealthPingRequest;

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
          format: typeof EXPORT_FORMAT.ORIGINAL;
          data: ConversationData;
      }
    | {
          ok: true;
          api: ExternalApiVersion;
          ts: number;
          conversation_id: string;
          format: typeof EXPORT_FORMAT.COMMON;
          data: CommonConversationExport;
      }
    | {
          ok: true;
          api: ExternalApiVersion;
          ts: number;
          format: typeof EXPORT_FORMAT.ORIGINAL;
          head_seq: number;
          events: ExternalOriginalConversationEvent[];
      }
    | {
          ok: true;
          api: ExternalApiVersion;
          ts: number;
          format: typeof EXPORT_FORMAT.COMMON;
          head_seq: number;
          events: ExternalCommonConversationEvent[];
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
    event: ExternalInboundConversationEvent;
};

export type ExternalSubscribeMessage = {
    type: 'subscribe';
    cursor: number;
    consumer_role: 'delivery';
    max_batch?: number;
    payload_format?: ExternalPullFormat;
};

export type ExternalCommitMessage = {
    type: 'commit';
    up_to_seq: number;
};

export type ExternalPortInboundMessage = ExternalSubscribeMessage | ExternalCommitMessage;

export type ExternalEventsBatchMessage = {
    type: 'events.batch';
    events: ExternalConversationEvent[];
    head_seq: number;
    batch_start: number;
    batch_end: number;
};

export type ExternalReplayCompleteMessage = {
    type: 'replay.complete';
    cursor: number;
    head_seq: number;
};

export type ExternalWakeMessage = {
    type: 'BLACKIYA_WAKE';
    head_seq: number;
    ts: number;
};

export type ExternalPortOutboundMessage =
    | ExternalConversationEvent
    | ExternalEventsBatchMessage
    | ExternalReplayCompleteMessage;

const isExternalApiVersion = (value: unknown): value is ExternalApiVersion => value === EXTERNAL_API_VERSION;
const isNonNegativeInteger = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isPositiveInteger = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0;

const isExternalProvider = (value: unknown): value is ExternalProvider =>
    value === 'chatgpt' || value === 'gemini' || value === 'grok' || value === 'unknown';

const isExternalPushEventType = (value: unknown): value is ExternalPushEventType =>
    typeof value === 'string' && (EXTERNAL_PUSH_EVENT_TYPES as readonly string[]).includes(value);

const isExternalPullFormat = (value: unknown): value is ExternalPullFormat =>
    value === EXPORT_FORMAT.ORIGINAL || value === EXPORT_FORMAT.COMMON;

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

const isCommonConversationExportLike = (value: unknown): value is CommonConversationExport => {
    if (!isRecord(value)) {
        return false;
    }
    return (
        value.format === EXPORT_FORMAT.COMMON &&
        hasString(value.llm) &&
        (value.model === undefined || hasString(value.model)) &&
        (value.title === undefined || hasString(value.title)) &&
        (value.conversation_id === undefined || hasString(value.conversation_id)) &&
        (value.created_at === undefined || hasString(value.created_at)) &&
        (value.updated_at === undefined || hasString(value.updated_at)) &&
        typeof value.prompt === 'string' &&
        typeof value.response === 'string' &&
        isStringArray(value.reasoning)
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
        isNonNegativeInteger(value.seq) &&
        isNonNegativeInteger(value.created_at) &&
        isNonNegativeInteger(value.ts) &&
        isExternalPullFormat(value.format) &&
        isExternalProvider(value.provider) &&
        (value.tab_id === undefined || isNonNegativeInteger(value.tab_id)) &&
        hasString(value.conversation_id) &&
        ((value.format === EXPORT_FORMAT.ORIGINAL && isConversationDataLike(value.payload)) ||
            (value.format === EXPORT_FORMAT.COMMON && isCommonConversationExportLike(value.payload))) &&
        (value.attempt_id === undefined || isNullableString(value.attempt_id)) &&
        isExportMeta(value.capture_meta) &&
        isNullableString(value.content_hash)
    );
};

export const isExternalInboundConversationEvent = (value: unknown): value is ExternalInboundConversationEvent => {
    if (!isRecord(value)) {
        return false;
    }
    return (
        isExternalApiVersion(value.api) &&
        isExternalPushEventType(value.type) &&
        hasString(value.event_id) &&
        (value.seq === undefined || isNonNegativeInteger(value.seq)) &&
        (value.created_at === undefined || isNonNegativeInteger(value.created_at)) &&
        isNonNegativeInteger(value.ts) &&
        (value.format === undefined || value.format === EXPORT_FORMAT.ORIGINAL) &&
        isExternalProvider(value.provider) &&
        (value.tab_id === undefined || isNonNegativeInteger(value.tab_id)) &&
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
    return value.type === EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE && isExternalInboundConversationEvent(value.event);
};

const isExternalGetLatestRequest = (value: Record<string, unknown>): value is ExternalGetLatestRequest => {
    if (value.type !== 'conversation.getLatest') {
        return false;
    }
    return (
        (value.tab_id === undefined || isNonNegativeInteger(value.tab_id)) &&
        (value.format === undefined || isExternalPullFormat(value.format))
    );
};

const isExternalGetByIdRequest = (value: Record<string, unknown>): value is ExternalGetByIdRequest => {
    if (value.type !== 'conversation.getById') {
        return false;
    }
    return hasString(value.conversation_id) && (value.format === undefined || isExternalPullFormat(value.format));
};

const isExternalGetSinceRequest = (value: Record<string, unknown>): value is ExternalGetSinceRequest => {
    if (value.type !== 'events.getSince') {
        return false;
    }
    return (
        isNonNegativeInteger(value.cursor) &&
        (value.limit === undefined || isPositiveInteger(value.limit)) &&
        (value.format === undefined || isExternalPullFormat(value.format))
    );
};

const isExternalHealthPingRequest = (value: Record<string, unknown>): value is ExternalHealthPingRequest =>
    value.type === 'health.ping';

export const isExternalRequest = (value: unknown): value is ExternalRequest => {
    if (!isRecord(value) || !isExternalApiVersion(value.api)) {
        return false;
    }
    return (
        isExternalGetLatestRequest(value) ||
        isExternalGetByIdRequest(value) ||
        isExternalGetSinceRequest(value) ||
        isExternalHealthPingRequest(value)
    );
};

export const isExternalSubscribeMessage = (value: unknown): value is ExternalSubscribeMessage => {
    if (!isRecord(value) || value.type !== 'subscribe') {
        return false;
    }
    return (
        isNonNegativeInteger(value.cursor) &&
        value.consumer_role === 'delivery' &&
        (value.max_batch === undefined || isPositiveInteger(value.max_batch)) &&
        (value.payload_format === undefined || isExternalPullFormat(value.payload_format))
    );
};

export const isExternalCommitMessage = (value: unknown): value is ExternalCommitMessage => {
    if (!isRecord(value) || value.type !== 'commit') {
        return false;
    }
    return isNonNegativeInteger(value.up_to_seq);
};

export const isExternalPortInboundMessage = (value: unknown): value is ExternalPortInboundMessage =>
    isExternalSubscribeMessage(value) || isExternalCommitMessage(value);

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
