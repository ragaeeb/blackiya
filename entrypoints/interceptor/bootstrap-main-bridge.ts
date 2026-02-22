import { getPageConversationSnapshot } from '@/entrypoints/interceptor/page-snapshot';
import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import type {
    AttemptDisposedMessage,
    CaptureInterceptedMessage,
    SessionInitMessage,
    StreamDumpConfigMessage,
} from '@/utils/protocol/messages';
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

const MAIN_BRIDGE_INSTALLED_KEY = '__BLACKIYA_MAIN_BRIDGE_INSTALLED__';

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

export type MainWorldBridgeDeps = {
    getRawCaptureHistory: () => CaptureInterceptedMessage[];
    cleanupDisposedAttempt: (attemptId: string) => void;
    setStreamDumpEnabled: (enabled: boolean) => void;
    clearStreamDumpCaches: () => void;
};

export const setupMainWorldBridge = (deps: MainWorldBridgeDeps) => {
    if ((window as any)[MAIN_BRIDGE_INSTALLED_KEY] === true) {
        return;
    }
    (window as any)[MAIN_BRIDGE_INSTALLED_KEY] = true;

    window.addEventListener('message', (event: MessageEvent) => {
        const snapshotRequest = isSnapshotRequestEvent(event);
        if (snapshotRequest) {
            if (resolveTokenValidationFailureReason(snapshotRequest) !== null) {
                return;
            }
            const conversationId =
                typeof snapshotRequest.conversationId === 'string' ? snapshotRequest.conversationId : '';
            const snapshot = conversationId
                ? getPageConversationSnapshot(conversationId, deps.getRawCaptureHistory)
                : null;
            window.postMessage(
                stampToken(buildSnapshotResponse(snapshotRequest.requestId, snapshot)),
                window.location.origin,
            );
            return;
        }

        if (!isSameWindowOriginEvent(event)) {
            return;
        }

        const message = event.data;
        if (!message || typeof message !== 'object') {
            return;
        }

        switch ((message as { type?: unknown }).type) {
            case MESSAGE_TYPES.ATTEMPT_DISPOSED: {
                const attemptDisposedMessage = message as AttemptDisposedMessage & {
                    __blackiyaToken?: string;
                };
                if (typeof attemptDisposedMessage.attemptId !== 'string') {
                    return;
                }
                if (resolveTokenValidationFailureReason(attemptDisposedMessage) !== null) {
                    return;
                }
                deps.cleanupDisposedAttempt(attemptDisposedMessage.attemptId);
                return;
            }
            case MESSAGE_TYPES.STREAM_DUMP_CONFIG: {
                const streamDumpConfigMessage = message as StreamDumpConfigMessage & {
                    __blackiyaToken?: string;
                };
                if (typeof streamDumpConfigMessage.enabled !== 'boolean') {
                    return;
                }
                if (resolveTokenValidationFailureReason(streamDumpConfigMessage) !== null) {
                    return;
                }
                deps.setStreamDumpEnabled(streamDumpConfigMessage.enabled);
                if (!streamDumpConfigMessage.enabled) {
                    deps.clearStreamDumpCaches();
                }
                return;
            }
            case MESSAGE_TYPES.SESSION_INIT: {
                const sessionInitMessage = message as SessionInitMessage;
                if (typeof sessionInitMessage.token !== 'string') {
                    return;
                }
                if (shouldApplySessionInitToken(getSessionToken(), sessionInitMessage.token)) {
                    setSessionToken(sessionInitMessage.token);
                }
                return;
            }
            default:
                return;
        }
    });
};
