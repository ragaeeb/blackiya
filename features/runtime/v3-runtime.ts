export const V3_MESSAGE_TYPES = {
    EXPORT_CHATS: 'BLACKIYA_V3_EXPORT_CHATS',
    EXPORT_STREAM_DEBUG: 'BLACKIYA_V3_EXPORT_STREAM_DEBUG',
    CLEAR_STREAM_DEBUG: 'BLACKIYA_V3_CLEAR_STREAM_DEBUG',
} as const;

export type V3BulkExportOptions = {
    limit: number;
    delayMs: number;
    timeoutMs: number;
};

export type V3RuntimeMessage =
    | ({ type: typeof V3_MESSAGE_TYPES.EXPORT_CHATS } & V3BulkExportOptions)
    | { type: typeof V3_MESSAGE_TYPES.EXPORT_STREAM_DEBUG }
    | { type: typeof V3_MESSAGE_TYPES.CLEAR_STREAM_DEBUG };

export type V3RuntimeResponse =
    | { ok: true; result?: unknown }
    | { ok: false; error: string };

export type V3RuntimeDependencies = {
    runBulkExport: (options: V3BulkExportOptions) => Promise<unknown>;
    exportStreamDebug: () => Promise<unknown>;
    clearStreamDebug: () => Promise<void>;
};

export type V3RuntimeMessageListener = (message: unknown) => Promise<V3RuntimeResponse>;

export type V3RuntimeHost = {
    onMessage: {
        addListener: (listener: V3RuntimeMessageListener) => void;
        removeListener: (listener: V3RuntimeMessageListener) => void;
    };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return !!value && typeof value === 'object' && !Array.isArray(value);
};

const isFiniteNonNegativeNumber = (value: unknown): value is number => {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
};

const isBulkExportOptions = (value: Record<string, unknown>): value is Record<string, unknown> & V3BulkExportOptions => {
    return (
        typeof value.limit === 'number' &&
        Number.isInteger(value.limit) &&
        value.limit >= 0 &&
        isFiniteNonNegativeNumber(value.delayMs) &&
        isFiniteNonNegativeNumber(value.timeoutMs)
    );
};

const errorMessage = (error: unknown): string => {
    return error instanceof Error ? error.message : String(error);
};

const handleV3RuntimeMessage = async (
    message: unknown,
    deps: V3RuntimeDependencies,
): Promise<V3RuntimeResponse> => {
    if (!isRecord(message) || typeof message.type !== 'string') {
        return { ok: false, error: 'Unsupported v3 message.' };
    }

    try {
        switch (message.type) {
            case V3_MESSAGE_TYPES.EXPORT_CHATS:
                if (!isBulkExportOptions(message)) {
                    return { ok: false, error: 'Invalid bulk export options.' };
                }
                return {
                    ok: true,
                    result: await deps.runBulkExport({
                        limit: message.limit,
                        delayMs: message.delayMs,
                        timeoutMs: message.timeoutMs,
                    }),
                };
            case V3_MESSAGE_TYPES.EXPORT_STREAM_DEBUG:
                return { ok: true, result: await deps.exportStreamDebug() };
            case V3_MESSAGE_TYPES.CLEAR_STREAM_DEBUG:
                await deps.clearStreamDebug();
                return { ok: true };
            default:
                return { ok: false, error: 'Unsupported v3 message.' };
        }
    } catch (error) {
        return { ok: false, error: errorMessage(error) };
    }
};

export const createV3Runtime = (host: V3RuntimeHost, deps: V3RuntimeDependencies) => {
    const listener: V3RuntimeMessageListener = (message) => handleV3RuntimeMessage(message, deps);
    host.onMessage.addListener(listener);

    return () => {
        host.onMessage.removeListener(listener);
    };
};
