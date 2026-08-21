import { V3_STREAM_DEBUG_MESSAGE_TYPES, type V3StreamDebugWindow } from '@/features/runtime/v3-stream-debug-bridge';
import type { StreamDebugRecorder } from '@/features/stream-debug/recorder';
import { getSessionToken, stampToken } from '@/utils/protocol/session-token';

export type StreamDebugBridgeOptions = {
    window: V3StreamDebugWindow;
    recorder: StreamDebugRecorder;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return !!value && typeof value === 'object' && !Array.isArray(value);
};

type StreamDebugMessageEvent = {
    data: unknown;
    origin?: string;
    source?: unknown;
};

const isAllowedSource = (win: V3StreamDebugWindow, source: unknown): boolean =>
    source === win.self || source === win || source === undefined || source === null;

const isAllowedOrigin = (win: V3StreamDebugWindow, origin: string | undefined): boolean => {
    const winOrigin = win.location.origin;
    return !origin || !winOrigin || origin === winOrigin || origin === 'null' || winOrigin === 'null';
};

const isAllowedMessageEvent = (win: V3StreamDebugWindow, event: StreamDebugMessageEvent): boolean =>
    Boolean(win?.location) &&
    isAllowedSource(win, event.source) &&
    isAllowedOrigin(win, event.origin) &&
    isRecord(event.data);

const resolveBridgeToken = (win: V3StreamDebugWindow): string | undefined =>
    (win as any).__BLACKIYA_SESSION_TOKEN__ ?? getSessionToken();

const hasValidToken = (win: V3StreamDebugWindow, data: Record<string, unknown>): boolean => {
    const sessionToken = resolveBridgeToken(win);
    const messageToken = data.__blackiyaToken;
    return (
        typeof messageToken === 'string' &&
        messageToken.length > 0 &&
        typeof sessionToken === 'string' &&
        sessionToken.length > 0 &&
        messageToken === sessionToken
    );
};

const postBridgeResponse = (win: V3StreamDebugWindow, response: Record<string, unknown>) => {
    const pageToken = (win as any).__BLACKIYA_SESSION_TOKEN__;
    if (typeof pageToken === 'string' && pageToken.length > 0) {
        response.__blackiyaToken = pageToken;
    }
    win.postMessage(response, win.location.origin);
};

export const setupStreamDebugBridge = ({ window: win, recorder }: StreamDebugBridgeOptions): (() => void) => {
    const handleMessage = (event: StreamDebugMessageEvent) => {
        if (!isAllowedMessageEvent(win, event)) {
            return;
        }

        const data = event.data as Record<string, unknown>;
        const type = data.type;
        const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;

        if (!requestId || typeof type !== 'string') {
            return;
        }

        if (!hasValidToken(win, data)) {
            return;
        }

        if (type === V3_STREAM_DEBUG_MESSAGE_TYPES.EXPORT_REQUEST) {
            const records = recorder.exportRecords();
            const response = stampToken({
                type: V3_STREAM_DEBUG_MESSAGE_TYPES.EXPORT_RESPONSE,
                requestId,
                ok: true,
                records,
            });
            postBridgeResponse(win, response);
            return;
        }

        if (type === V3_STREAM_DEBUG_MESSAGE_TYPES.CLEAR_REQUEST) {
            recorder.clear();
            const response = stampToken({
                type: V3_STREAM_DEBUG_MESSAGE_TYPES.CLEAR_RESPONSE,
                requestId,
                ok: true,
            });
            postBridgeResponse(win, response);
        }
    };

    win.addEventListener('message', handleMessage as any);
    return () => {
        win.removeEventListener('message', handleMessage as any);
    };
};
