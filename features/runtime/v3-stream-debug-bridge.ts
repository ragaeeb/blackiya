export const V3_STREAM_DEBUG_MESSAGE_TYPES = {
    EXPORT_REQUEST: 'BLACKIYA_V3_STREAM_DEBUG_EXPORT_REQUEST',
    EXPORT_RESPONSE: 'BLACKIYA_V3_STREAM_DEBUG_EXPORT_RESPONSE',
    CLEAR_REQUEST: 'BLACKIYA_V3_STREAM_DEBUG_CLEAR_REQUEST',
    CLEAR_RESPONSE: 'BLACKIYA_V3_STREAM_DEBUG_CLEAR_RESPONSE',
} as const;

type V3StreamDebugMessageType = (typeof V3_STREAM_DEBUG_MESSAGE_TYPES)[keyof typeof V3_STREAM_DEBUG_MESSAGE_TYPES];

type V3StreamDebugMessageEvent = {
    data: unknown;
    origin: string;
    source: unknown;
};

export type V3StreamDebugWindow = {
    location: { origin: string };
    self: unknown;
    postMessage: (data: unknown, targetOrigin: string) => void;
    addEventListener: (type: 'message', listener: (event: V3StreamDebugMessageEvent) => void) => void;
    removeEventListener: (type: 'message', listener: (event: V3StreamDebugMessageEvent) => void) => void;
};

export type V3StreamDebugBridgeDependencies = {
    window: V3StreamDebugWindow;
    timeoutMs?: number;
    createRequestId?: () => string;
    token?: string;
};

export type V3StreamDebugBridge = {
    exportRecords: () => Promise<unknown[]>;
    clearRecords: () => Promise<void>;
    dispose: () => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return !!value && typeof value === 'object' && !Array.isArray(value);
};

const defaultRequestId = (): string => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return crypto.randomUUID();
    }
    return `stream-debug-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const normalizeTimeout = (value: number | undefined): number => {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 5000;
};

export const createV3StreamDebugBridge = ({
    window: windowLike,
    timeoutMs: configuredTimeoutMs,
    createRequestId = defaultRequestId,
    token,
}: V3StreamDebugBridgeDependencies): V3StreamDebugBridge => {
    const timeoutMs = normalizeTimeout(configuredTimeoutMs);
    const pendingCleanups = new Set<() => void>();

    const request = (requestType: V3StreamDebugMessageType, responseType: V3StreamDebugMessageType) => {
        return new Promise<unknown>((resolve, reject) => {
            const requestId = createRequestId();
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

            const cleanup = () => {
                windowLike.removeEventListener('message', handleMessage);
                if (timeoutHandle !== undefined) {
                    clearTimeout(timeoutHandle);
                }
                pendingCleanups.delete(cleanup);
            };

            const finish = (callback: () => void) => {
                cleanup();
                callback();
            };

            const handleMessage = (event: V3StreamDebugMessageEvent) => {
                const data = event.data;
                if (event.source !== windowLike.self || event.origin !== windowLike.location.origin || !isRecord(data)) {
                    return;
                }
                if (
                    data.type !== responseType ||
                    data.requestId !== requestId ||
                    (token !== undefined && data.__blackiyaToken !== token)
                ) {
                    return;
                }

                if (data.ok !== true) {
                    finish(() => reject(new Error(typeof data.error === 'string' ? data.error : 'Stream-debug bridge failed.')));
                    return;
                }

                finish(() => resolve(data.records ?? undefined));
            };

            pendingCleanups.add(cleanup);
            windowLike.addEventListener('message', handleMessage);
            timeoutHandle = setTimeout(() => {
                finish(() => reject(new Error('Stream-debug bridge timed out.')));
            }, timeoutMs);

            windowLike.postMessage(
                {
                    type: requestType,
                    requestId,
                    ...(token === undefined ? {} : { __blackiyaToken: token }),
                },
                windowLike.location.origin,
            );
        });
    };

    return {
        exportRecords: async () => {
            const records = await request(
                V3_STREAM_DEBUG_MESSAGE_TYPES.EXPORT_REQUEST,
                V3_STREAM_DEBUG_MESSAGE_TYPES.EXPORT_RESPONSE,
            );
            return Array.isArray(records) ? records : [];
        },
        clearRecords: async () => {
            await request(V3_STREAM_DEBUG_MESSAGE_TYPES.CLEAR_REQUEST, V3_STREAM_DEBUG_MESSAGE_TYPES.CLEAR_RESPONSE);
        },
        dispose: () => {
            for (const cleanup of Array.from(pendingCleanups)) {
                cleanup();
            }
        },
    };
};
