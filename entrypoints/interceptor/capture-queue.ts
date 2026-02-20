import type { CaptureInterceptedMessage as CapturePayload, LogEntryMessage } from '@/utils/protocol/messages';

const MAX_LOG_QUEUE_SIZE = 100;
const MAX_CAPTURE_QUEUE_SIZE = 50;
const MAX_CAPTURE_HISTORY_SIZE = 30;

export const appendToLogQueue = (payload: LogEntryMessage & { __blackiyaToken: string }) => {
    const queue = ((window as any).__BLACKIYA_LOG_QUEUE__ as (typeof payload)[] | undefined) ?? [];
    queue.push(payload);
    if (queue.length > MAX_LOG_QUEUE_SIZE) {
        queue.splice(0, queue.length - MAX_LOG_QUEUE_SIZE);
    }
    (window as any).__BLACKIYA_LOG_QUEUE__ = queue;
};

const cacheInHistory = (payload: CapturePayload) => {
    const history = ((window as any).__BLACKIYA_RAW_CAPTURE_HISTORY__ as CapturePayload[] | undefined) ?? [];
    history.push(payload);
    if (history.length > MAX_CAPTURE_HISTORY_SIZE) {
        history.splice(0, history.length - MAX_CAPTURE_HISTORY_SIZE);
    }
    (window as any).__BLACKIYA_RAW_CAPTURE_HISTORY__ = history;
};

export const appendToCaptureQueue = (payload: CapturePayload & { __blackiyaToken: string }) => {
    const queue = ((window as any).__BLACKIYA_CAPTURE_QUEUE__ as (typeof payload)[] | undefined) ?? [];
    queue.push(payload);
    if (queue.length > MAX_CAPTURE_QUEUE_SIZE) {
        queue.splice(0, queue.length - MAX_CAPTURE_QUEUE_SIZE);
    }
    (window as any).__BLACKIYA_CAPTURE_QUEUE__ = queue;
    cacheInHistory(payload);
};

export const getRawCaptureHistory = () => {
    const history = (window as any).__BLACKIYA_RAW_CAPTURE_HISTORY__;
    return Array.isArray(history) ? (history as CapturePayload[]) : [];
};
