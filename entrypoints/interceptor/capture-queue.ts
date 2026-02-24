import type { CaptureInterceptedMessage as CapturePayload, LogEntryMessage } from '@/utils/protocol/messages';

const MAX_LOG_QUEUE_SIZE = 100;
const MAX_CAPTURE_QUEUE_SIZE = 50;
const MAX_CAPTURE_HISTORY_SIZE = 30;
const DROP_WARN_INTERVAL_MS = 10_000;

type QueueDropStats = {
    logDropped: number;
    captureDropped: number;
    historyDropped: number;
    lastWarnAtByQueue: Record<'log' | 'capture' | 'history', number>;
};

const getQueueDropStats = (): QueueDropStats => {
    const existing = (window as any).__BLACKIYA_QUEUE_DROP_STATS__;
    if (existing && typeof existing === 'object') {
        return existing as QueueDropStats;
    }
    const next: QueueDropStats = {
        logDropped: 0,
        captureDropped: 0,
        historyDropped: 0,
        lastWarnAtByQueue: { log: 0, capture: 0, history: 0 },
    };
    (window as any).__BLACKIYA_QUEUE_DROP_STATS__ = next;
    return next;
};

const maybeWarnQueueDrop = (queue: 'log' | 'capture' | 'history', dropped: number, maxSize: number) => {
    if (dropped <= 0) {
        return;
    }
    const stats = getQueueDropStats();
    const now = Date.now();
    if (now - stats.lastWarnAtByQueue[queue] < DROP_WARN_INTERVAL_MS) {
        return;
    }
    stats.lastWarnAtByQueue[queue] = now;
    const totalDropped =
        queue === 'log' ? stats.logDropped : queue === 'capture' ? stats.captureDropped : stats.historyDropped;
    console.debug(`[Blackiya] ${queue} queue dropped ${dropped} message(s) to enforce max size ${maxSize}`, {
        queue,
        dropped,
        totalDropped,
        maxSize,
    });
};

export const appendToLogQueue = (payload: LogEntryMessage & { __blackiyaToken: string }) => {
    const queue = ((window as any).__BLACKIYA_LOG_QUEUE__ as (typeof payload)[] | undefined) ?? [];
    queue.push(payload);
    if (queue.length > MAX_LOG_QUEUE_SIZE) {
        const dropped = queue.length - MAX_LOG_QUEUE_SIZE;
        queue.splice(0, dropped);
        const stats = getQueueDropStats();
        stats.logDropped += dropped;
        maybeWarnQueueDrop('log', dropped, MAX_LOG_QUEUE_SIZE);
    }
    (window as any).__BLACKIYA_LOG_QUEUE__ = queue;
};

const cacheInHistory = (payload: CapturePayload) => {
    const history = ((window as any).__BLACKIYA_RAW_CAPTURE_HISTORY__ as CapturePayload[] | undefined) ?? [];
    history.push(payload);
    if (history.length > MAX_CAPTURE_HISTORY_SIZE) {
        const dropped = history.length - MAX_CAPTURE_HISTORY_SIZE;
        history.splice(0, dropped);
        const stats = getQueueDropStats();
        stats.historyDropped += dropped;
        maybeWarnQueueDrop('history', dropped, MAX_CAPTURE_HISTORY_SIZE);
    }
    (window as any).__BLACKIYA_RAW_CAPTURE_HISTORY__ = history;
};

export const appendToCaptureQueue = (payload: CapturePayload & { __blackiyaToken: string }) => {
    const queue = ((window as any).__BLACKIYA_CAPTURE_QUEUE__ as (typeof payload)[] | undefined) ?? [];
    queue.push(payload);
    if (queue.length > MAX_CAPTURE_QUEUE_SIZE) {
        const dropped = queue.length - MAX_CAPTURE_QUEUE_SIZE;
        queue.splice(0, dropped);
        const stats = getQueueDropStats();
        stats.captureDropped += dropped;
        maybeWarnQueueDrop('capture', dropped, MAX_CAPTURE_QUEUE_SIZE);
    }
    (window as any).__BLACKIYA_CAPTURE_QUEUE__ = queue;
    cacheInHistory(payload);
};

export const getRawCaptureHistory = () => {
    const history = (window as any).__BLACKIYA_RAW_CAPTURE_HISTORY__;
    return Array.isArray(history) ? (history as CapturePayload[]) : [];
};

export const getCaptureQueueDropStats = (): QueueDropStats => getQueueDropStats();
