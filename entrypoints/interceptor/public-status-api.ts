import type { BlackiyaPublicEventName, BlackiyaPublicStatus } from '@/utils/protocol/messages';

export type { BlackiyaPublicStatus } from '@/utils/protocol/messages';

export type BlackiyaPublicStatusListener = (status: BlackiyaPublicStatus) => void;

export type BlackiyaPublicSubscriptionOptions = {
    emitCurrent?: boolean;
};

const DEFAULT_STATUS: BlackiyaPublicStatus = {
    platform: null,
    conversationId: null,
    attemptId: null,
    lifecycle: 'idle',
    readiness: 'unknown',
    readinessReason: null,
    canGetJSON: false,
    canGetCommonJSON: false,
    sequence: 0,
    timestampMs: 0,
};

const cloneStatus = (status: BlackiyaPublicStatus): BlackiyaPublicStatus => ({ ...status });

const isReadyStatus = (status: BlackiyaPublicStatus) => status.canGetJSON && status.canGetCommonJSON;

const buildReadyKey = (status: BlackiyaPublicStatus) =>
    `${status.platform ?? 'unknown'}:${status.conversationId ?? 'none'}:${status.attemptId ?? 'none'}`;

const notifyListener = (listener: BlackiyaPublicStatusListener, status: BlackiyaPublicStatus) => {
    try {
        listener(cloneStatus(status));
    } catch {
        // Isolate listener failures so one client cannot break others.
    }
};

const emitToListeners = (listeners: Set<BlackiyaPublicStatusListener>, status: BlackiyaPublicStatus) => {
    for (const listener of listeners) {
        notifyListener(listener, status);
    }
};

export const createBlackiyaPublicStatusApi = (initialStatus: BlackiyaPublicStatus = DEFAULT_STATUS) => {
    let currentStatus = cloneStatus(initialStatus);
    let lastReadyKey = isReadyStatus(currentStatus) ? buildReadyKey(currentStatus) : null;
    const statusListeners = new Set<BlackiyaPublicStatusListener>();
    const readyListeners = new Set<BlackiyaPublicStatusListener>();

    const getStatus = () => cloneStatus(currentStatus);

    const applyStatus = (status: BlackiyaPublicStatus) => {
        currentStatus = cloneStatus(status);
        emitToListeners(statusListeners, currentStatus);

        const readyKey = isReadyStatus(currentStatus) ? buildReadyKey(currentStatus) : null;
        if (readyKey && readyKey !== lastReadyKey) {
            emitToListeners(readyListeners, currentStatus);
        }
        lastReadyKey = readyKey;
    };

    const subscribe = (
        event: BlackiyaPublicEventName,
        listener: BlackiyaPublicStatusListener,
        options: BlackiyaPublicSubscriptionOptions = {},
    ) => {
        const emitCurrent = options.emitCurrent !== false;
        const listeners = event === 'ready' ? readyListeners : statusListeners;
        listeners.add(listener);

        if (emitCurrent) {
            if (event === 'status') {
                notifyListener(listener, currentStatus);
            } else if (isReadyStatus(currentStatus)) {
                notifyListener(listener, currentStatus);
            }
        }

        return () => {
            listeners.delete(listener);
        };
    };

    const onStatusChange = (listener: BlackiyaPublicStatusListener, options?: BlackiyaPublicSubscriptionOptions) =>
        subscribe('status', listener, options);

    const onReady = (listener: BlackiyaPublicStatusListener, options?: BlackiyaPublicSubscriptionOptions) =>
        subscribe('ready', listener, options);

    return {
        applyStatus,
        getStatus,
        subscribe,
        onStatusChange,
        onReady,
    };
};
