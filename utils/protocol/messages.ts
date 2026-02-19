import { MESSAGE_TYPES } from '@/utils/protocol/constants';

export type LifecyclePhaseWire = 'prompt-sent' | 'streaming' | 'completed' | 'terminated';

export type LogLevelWire = 'debug' | 'info' | 'warn' | 'error';
export type BlackiyaPublicEventName = 'status' | 'ready';
export type BlackiyaPublicLifecycleState = 'idle' | 'prompt-sent' | 'streaming' | 'completed';
export type BlackiyaPublicReadinessState =
    | 'unknown'
    | 'awaiting_stabilization'
    | 'canonical_ready'
    | 'degraded_manual_only';

export type BlackiyaPublicStatus = {
    platform: string | null;
    conversationId: string | null;
    attemptId: string | null;
    lifecycle: BlackiyaPublicLifecycleState;
    readiness: BlackiyaPublicReadinessState;
    readinessReason: string | null;
    canGetJSON: boolean;
    canGetCommonJSON: boolean;
    sequence: number;
    timestampMs: number;
};

type TokenStampedWireMessage = {
    __blackiyaToken?: string;
};

export type ResponseLifecycleMessage = {
    type: typeof MESSAGE_TYPES.RESPONSE_LIFECYCLE;
    platform: string;
    attemptId: string;
    phase: LifecyclePhaseWire;
    conversationId?: string;
} & TokenStampedWireMessage;

export type ResponseFinishedMessage = {
    type: typeof MESSAGE_TYPES.RESPONSE_FINISHED;
    platform: string;
    attemptId: string;
    conversationId?: string;
} & TokenStampedWireMessage;

export type StreamDeltaMessage = {
    type: typeof MESSAGE_TYPES.STREAM_DELTA;
    platform: string;
    attemptId: string;
    conversationId?: string;
    text: string;
} & TokenStampedWireMessage;

export type ConversationIdResolvedMessage = {
    type: typeof MESSAGE_TYPES.CONVERSATION_ID_RESOLVED;
    platform: string;
    attemptId: string;
    conversationId: string;
} & TokenStampedWireMessage;

export type AttemptDisposedMessage = {
    type: typeof MESSAGE_TYPES.ATTEMPT_DISPOSED;
    attemptId: string;
    reason: 'navigation' | 'superseded' | 'timeout' | 'teardown';
} & TokenStampedWireMessage;

export type StreamDumpConfigMessage = {
    type: typeof MESSAGE_TYPES.STREAM_DUMP_CONFIG;
    enabled: boolean;
} & TokenStampedWireMessage;

export type TitleResolvedMessage = {
    type: typeof MESSAGE_TYPES.TITLE_RESOLVED;
    platform: string;
    attemptId: string;
    conversationId: string;
    title: string;
} & TokenStampedWireMessage;

export type StreamDumpFrameMessage = {
    type: typeof MESSAGE_TYPES.STREAM_DUMP_FRAME;
    platform: string;
    attemptId: string;
    conversationId?: string;
    kind: 'snapshot' | 'heuristic' | 'delta' | 'lifecycle';
    text: string;
    chunkBytes?: number;
    frameIndex?: number;
    timestampMs?: number;
} & TokenStampedWireMessage;

export type CaptureInterceptedMessage = {
    type: typeof MESSAGE_TYPES.CAPTURE_DATA_INTERCEPTED;
    platform: string;
    url: string;
    data: string;
    attemptId?: string;
} & TokenStampedWireMessage;

export type LogEntryMessage = {
    type: typeof MESSAGE_TYPES.LOG_ENTRY;
    payload: {
        level: LogLevelWire;
        message: string;
        data?: unknown[];
        context?: string;
    };
} & TokenStampedWireMessage;

export type SessionInitMessage = {
    type: typeof MESSAGE_TYPES.SESSION_INIT;
    token: string;
};

export type PublicStatusMessage = {
    type: typeof MESSAGE_TYPES.PUBLIC_STATUS;
    status: BlackiyaPublicStatus;
} & TokenStampedWireMessage;

export type BlackiyaMessage =
    | ResponseLifecycleMessage
    | ResponseFinishedMessage
    | StreamDeltaMessage
    | ConversationIdResolvedMessage
    | AttemptDisposedMessage
    | TitleResolvedMessage
    | StreamDumpConfigMessage
    | StreamDumpFrameMessage
    | CaptureInterceptedMessage
    | LogEntryMessage
    | SessionInitMessage
    | PublicStatusMessage;

const hasString = (value: unknown): value is string => {
    return typeof value === 'string' && value.length > 0;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return !!value && typeof value === 'object' && !Array.isArray(value);
};

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

const isPublicLifecycleState = (value: unknown): value is BlackiyaPublicLifecycleState =>
    value === 'idle' || value === 'prompt-sent' || value === 'streaming' || value === 'completed';

const isPublicReadinessState = (value: unknown): value is BlackiyaPublicReadinessState =>
    value === 'unknown' ||
    value === 'awaiting_stabilization' ||
    value === 'canonical_ready' ||
    value === 'degraded_manual_only';

export const isBlackiyaPublicStatus = (value: unknown): value is BlackiyaPublicStatus => {
    if (!isRecord(value)) {
        return false;
    }
    return (
        isNullableString(value.platform) &&
        isNullableString(value.conversationId) &&
        isNullableString(value.attemptId) &&
        isPublicLifecycleState(value.lifecycle) &&
        isPublicReadinessState(value.readiness) &&
        isNullableString(value.readinessReason) &&
        isBoolean(value.canGetJSON) &&
        isBoolean(value.canGetCommonJSON) &&
        isNumber(value.sequence) &&
        isNumber(value.timestampMs)
    );
};

export const isBlackiyaMessage = (value: unknown): value is BlackiyaMessage => {
    if (!isRecord(value) || !hasString(value.type)) {
        return false;
    }

    switch (value.type) {
        case MESSAGE_TYPES.RESPONSE_LIFECYCLE:
            return hasString(value.platform) && hasString(value.attemptId) && hasString(value.phase);
        case MESSAGE_TYPES.RESPONSE_FINISHED:
            return hasString(value.platform) && hasString(value.attemptId);
        case MESSAGE_TYPES.STREAM_DELTA:
            return hasString(value.platform) && hasString(value.attemptId) && typeof value.text === 'string';
        case MESSAGE_TYPES.CONVERSATION_ID_RESOLVED:
            return hasString(value.platform) && hasString(value.attemptId) && hasString(value.conversationId);
        case MESSAGE_TYPES.ATTEMPT_DISPOSED:
            return hasString(value.attemptId) && hasString(value.reason);
        case MESSAGE_TYPES.TITLE_RESOLVED:
            return (
                hasString(value.platform) &&
                hasString(value.attemptId) &&
                hasString(value.conversationId) &&
                hasString(value.title)
            );
        case MESSAGE_TYPES.STREAM_DUMP_CONFIG:
            return typeof value.enabled === 'boolean';
        case MESSAGE_TYPES.STREAM_DUMP_FRAME:
            return (
                hasString(value.platform) &&
                hasString(value.attemptId) &&
                hasString(value.kind) &&
                typeof value.text === 'string'
            );
        case MESSAGE_TYPES.CAPTURE_DATA_INTERCEPTED:
            return hasString(value.platform) && hasString(value.url) && typeof value.data === 'string';
        case MESSAGE_TYPES.LOG_ENTRY:
            return isRecord(value.payload) && hasString(value.payload.level) && hasString(value.payload.message);
        case MESSAGE_TYPES.SESSION_INIT:
            return hasString(value.token);
        case MESSAGE_TYPES.PUBLIC_STATUS:
            return isBlackiyaPublicStatus(value.status);
        default:
            return false;
    }
};

export const createAttemptId = (prefix = 'attempt'): string => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return `${prefix}:${crypto.randomUUID()}`;
    }
    return `${prefix}:${Date.now()}-${Math.random().toString(16).slice(2)}`;
};
