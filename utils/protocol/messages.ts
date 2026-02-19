export type LifecyclePhaseWire = 'prompt-sent' | 'streaming' | 'completed' | 'terminated';

export type LogLevelWire = 'debug' | 'info' | 'warn' | 'error';

type TokenStampedWireMessage = {
    __blackiyaToken?: string;
};

export type ResponseLifecycleMessage = {
    type: 'BLACKIYA_RESPONSE_LIFECYCLE';
    platform: string;
    attemptId: string;
    phase: LifecyclePhaseWire;
    conversationId?: string;
} & TokenStampedWireMessage;

export type ResponseFinishedMessage = {
    type: 'BLACKIYA_RESPONSE_FINISHED';
    platform: string;
    attemptId: string;
    conversationId?: string;
} & TokenStampedWireMessage;

export type StreamDeltaMessage = {
    type: 'BLACKIYA_STREAM_DELTA';
    platform: string;
    attemptId: string;
    conversationId?: string;
    text: string;
} & TokenStampedWireMessage;

export type ConversationIdResolvedMessage = {
    type: 'BLACKIYA_CONVERSATION_ID_RESOLVED';
    platform: string;
    attemptId: string;
    conversationId: string;
} & TokenStampedWireMessage;

export type AttemptDisposedMessage = {
    type: 'BLACKIYA_ATTEMPT_DISPOSED';
    attemptId: string;
    reason: 'navigation' | 'superseded' | 'timeout' | 'teardown';
} & TokenStampedWireMessage;

export type StreamDumpConfigMessage = {
    type: 'BLACKIYA_STREAM_DUMP_CONFIG';
    enabled: boolean;
} & TokenStampedWireMessage;

export type TitleResolvedMessage = {
    type: 'BLACKIYA_TITLE_RESOLVED';
    platform: string;
    attemptId: string;
    conversationId: string;
    title: string;
} & TokenStampedWireMessage;

export type StreamDumpFrameMessage = {
    type: 'BLACKIYA_STREAM_DUMP_FRAME';
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
    type: 'LLM_CAPTURE_DATA_INTERCEPTED';
    platform: string;
    url: string;
    data: string;
    attemptId?: string;
} & TokenStampedWireMessage;

export type LogEntryMessage = {
    type: 'LLM_LOG_ENTRY';
    payload: {
        level: LogLevelWire;
        message: string;
        data?: unknown[];
        context?: string;
    };
} & TokenStampedWireMessage;

export type SessionInitMessage = {
    type: 'BLACKIYA_SESSION_INIT';
    token: string;
};

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
    | SessionInitMessage;

const hasString = (value: unknown): value is string => {
    return typeof value === 'string' && value.length > 0;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return !!value && typeof value === 'object' && !Array.isArray(value);
};

export const isBlackiyaMessage = (value: unknown): value is BlackiyaMessage => {
    if (!isRecord(value) || !hasString(value.type)) {
        return false;
    }

    switch (value.type) {
        case 'BLACKIYA_RESPONSE_LIFECYCLE':
            return hasString(value.platform) && hasString(value.attemptId) && hasString(value.phase);
        case 'BLACKIYA_RESPONSE_FINISHED':
            return hasString(value.platform) && hasString(value.attemptId);
        case 'BLACKIYA_STREAM_DELTA':
            return hasString(value.platform) && hasString(value.attemptId) && typeof value.text === 'string';
        case 'BLACKIYA_CONVERSATION_ID_RESOLVED':
            return hasString(value.platform) && hasString(value.attemptId) && hasString(value.conversationId);
        case 'BLACKIYA_ATTEMPT_DISPOSED':
            return hasString(value.attemptId) && hasString(value.reason);
        case 'BLACKIYA_TITLE_RESOLVED':
            return (
                hasString(value.platform) &&
                hasString(value.attemptId) &&
                hasString(value.conversationId) &&
                hasString(value.title)
            );
        case 'BLACKIYA_STREAM_DUMP_CONFIG':
            return typeof value.enabled === 'boolean';
        case 'BLACKIYA_STREAM_DUMP_FRAME':
            return (
                hasString(value.platform) &&
                hasString(value.attemptId) &&
                hasString(value.kind) &&
                typeof value.text === 'string'
            );
        case 'LLM_CAPTURE_DATA_INTERCEPTED':
            return hasString(value.platform) && hasString(value.url) && typeof value.data === 'string';
        case 'LLM_LOG_ENTRY':
            return isRecord(value.payload) && hasString(value.payload.level) && hasString(value.payload.message);
        case 'BLACKIYA_SESSION_INIT':
            return hasString(value.token);
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
