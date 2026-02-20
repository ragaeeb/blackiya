import { getPageConversationSnapshot } from '@/entrypoints/interceptor/page-snapshot';
import {
    type BlackiyaPublicSubscriptionOptions,
    createBlackiyaPublicStatusApi,
} from '@/entrypoints/interceptor/public-status-api';
import { createWindowJsonRequester } from '@/entrypoints/interceptor/snapshot-bridge';
import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import type {
    AttemptDisposedMessage,
    BlackiyaPublicEventName,
    BlackiyaPublicStatus,
    CaptureInterceptedMessage,
    PublicStatusMessage,
    SessionInitMessage,
    StreamDumpConfigMessage,
} from '@/utils/protocol/messages';
import { isBlackiyaPublicStatus } from '@/utils/protocol/messages';
import {
    getSessionToken,
    resolveTokenValidationFailureReason,
    setSessionToken,
    stampToken,
} from '@/utils/protocol/session-token';

type PageSnapshotRequest = {
    type: typeof MESSAGE_TYPES.PAGE_SNAPSHOT_REQUEST;
    requestId: string;
    conversationId: string;
    __blackiyaToken?: string;
};

type PageSnapshotResponse = {
    type: typeof MESSAGE_TYPES.PAGE_SNAPSHOT_RESPONSE;
    requestId: string;
    success: boolean;
    data?: unknown;
    error?: string;
    __blackiyaToken?: string;
};

const JSON_FORMAT_ORIGINAL = 'original';
const JSON_FORMAT_COMMON = 'common';

export const shouldApplySessionInitToken = (existingToken: string | undefined, incomingToken: string): boolean => {
    if (typeof incomingToken !== 'string' || incomingToken.length === 0) {
        return false;
    }
    return !(typeof existingToken === 'string' && existingToken.length > 0);
};

const isSameWindowOriginEvent = (event: MessageEvent) =>
    event.source === window && event.origin === window.location.origin;

const isSnapshotRequestEvent = (event: MessageEvent) => {
    if (!isSameWindowOriginEvent(event)) {
        return null;
    }
    const message = event.data as PageSnapshotRequest;
    if (message?.type !== MESSAGE_TYPES.PAGE_SNAPSHOT_REQUEST || typeof message.requestId !== 'string') {
        return null;
    }
    return message;
};

const buildSnapshotResponse = (requestId: string, snapshot: unknown | null): PageSnapshotResponse =>
    snapshot
        ? { type: MESSAGE_TYPES.PAGE_SNAPSHOT_RESPONSE, requestId, success: true, data: snapshot }
        : { type: MESSAGE_TYPES.PAGE_SNAPSHOT_RESPONSE, requestId, success: false, error: 'NOT_FOUND' };

export type BootstrapPublicApiDeps = {
    getRawCaptureHistory: () => CaptureInterceptedMessage[];
    cleanupDisposedAttempt: (attemptId: string) => void;
    setStreamDumpEnabled: (enabled: boolean) => void;
    clearStreamDumpCaches: () => void;
};

export const setupPublicWindowApi = (deps: BootstrapPublicApiDeps) => {
    if ((window as any).__blackiya) {
        return;
    }

    const requestJson = createWindowJsonRequester(window, {
        requestType: MESSAGE_TYPES.GET_JSON_REQUEST,
        responseType: MESSAGE_TYPES.GET_JSON_RESPONSE,
        timeoutMs: 5000,
    });
    const publicStatusApi = createBlackiyaPublicStatusApi();

    window.addEventListener('message', (event: MessageEvent) => {
        const message = isSnapshotRequestEvent(event);
        if (!message || resolveTokenValidationFailureReason(message) !== null) {
            return;
        }
        const conversationId = typeof message.conversationId === 'string' ? message.conversationId : '';
        const snapshot = conversationId ? getPageConversationSnapshot(conversationId, deps.getRawCaptureHistory) : null;
        window.postMessage(stampToken(buildSnapshotResponse(message.requestId, snapshot)), window.location.origin);
    });

    window.addEventListener('message', (event: MessageEvent) => {
        if (!isSameWindowOriginEvent(event)) {
            return;
        }
        const message = event.data as AttemptDisposedMessage & { __blackiyaToken?: string };
        if (message?.type !== MESSAGE_TYPES.ATTEMPT_DISPOSED || typeof message.attemptId !== 'string') {
            return;
        }
        const sessionToken = getSessionToken();
        if (sessionToken && message.__blackiyaToken !== sessionToken) {
            return;
        }
        deps.cleanupDisposedAttempt(message.attemptId);
    });

    window.addEventListener('message', (event: MessageEvent) => {
        if (!isSameWindowOriginEvent(event)) {
            return;
        }
        const message = event.data as StreamDumpConfigMessage & { __blackiyaToken?: string };
        if (message?.type !== MESSAGE_TYPES.STREAM_DUMP_CONFIG || typeof message.enabled !== 'boolean') {
            return;
        }
        const sessionToken = getSessionToken();
        if (sessionToken && message.__blackiyaToken !== sessionToken) {
            return;
        }
        deps.setStreamDumpEnabled(message.enabled);
        if (!message.enabled) {
            deps.clearStreamDumpCaches();
        }
    });

    window.addEventListener('message', (event: MessageEvent) => {
        if (!isSameWindowOriginEvent(event)) {
            return;
        }
        const message = event.data as SessionInitMessage;
        if (message?.type !== MESSAGE_TYPES.SESSION_INIT || typeof message.token !== 'string') {
            return;
        }
        if (shouldApplySessionInitToken(getSessionToken(), message.token)) {
            setSessionToken(message.token);
        }
    });

    window.addEventListener('message', (event: MessageEvent) => {
        if (!isSameWindowOriginEvent(event)) {
            return;
        }
        const message = event.data as PublicStatusMessage;
        if (
            message?.type !== MESSAGE_TYPES.PUBLIC_STATUS ||
            resolveTokenValidationFailureReason(message) !== null ||
            !isBlackiyaPublicStatus(message.status)
        ) {
            return;
        }
        publicStatusApi.applyStatus(message.status);
    });

    const subscribePublicEvent = (
        event: BlackiyaPublicEventName,
        callback: (status: BlackiyaPublicStatus) => void,
        options?: BlackiyaPublicSubscriptionOptions,
    ) => publicStatusApi.subscribe(event, callback, options);

    (window as any).__blackiya = {
        getJSON: () => requestJson(JSON_FORMAT_ORIGINAL),
        getCommonJSON: () => requestJson(JSON_FORMAT_COMMON),
        getStatus: () => publicStatusApi.getStatus(),
        subscribe: subscribePublicEvent,
        onStatusChange: (
            callback: (status: BlackiyaPublicStatus) => void,
            options?: BlackiyaPublicSubscriptionOptions,
        ) => subscribePublicEvent('status', callback, options),
        onReady: (callback: (status: BlackiyaPublicStatus) => void, options?: BlackiyaPublicSubscriptionOptions) =>
            subscribePublicEvent('ready', callback, options),
    };
};
