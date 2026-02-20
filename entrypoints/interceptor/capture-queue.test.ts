import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
    appendToCaptureQueue,
    appendToLogQueue,
    getCaptureQueueDropStats,
    getRawCaptureHistory,
} from '@/entrypoints/interceptor/capture-queue';

describe('capture-queue', () => {
    let originalWindow: unknown;

    beforeEach(() => {
        originalWindow = (globalThis as any).window;
        if (!(globalThis as any).window) {
            (globalThis as any).window = {};
        }
        const win = globalThis.window as any;
        delete win.__BLACKIYA_LOG_QUEUE__;
        delete win.__BLACKIYA_CAPTURE_QUEUE__;
        delete win.__BLACKIYA_RAW_CAPTURE_HISTORY__;
        delete win.__BLACKIYA_QUEUE_DROP_STATS__;
    });

    afterEach(() => {
        (globalThis as any).window = originalWindow;
    });

    describe('appendToLogQueue', () => {
        it('should append log entry to window queue', () => {
            const payload = { type: 'log', level: 'info', message: 'test', __blackiyaToken: 'token' } as any;
            appendToLogQueue(payload);
            const queue = (globalThis.window as any).__BLACKIYA_LOG_QUEUE__;
            expect(queue.length).toBe(1);
            expect(queue[0]).toBe(payload);
        });

        it('should cap the queue at 100 items', () => {
            for (let i = 0; i < 110; i++) {
                appendToLogQueue({ type: 'log', level: 'info', message: `msg-${i}`, __blackiyaToken: 'token' } as any);
            }
            const queue = (globalThis.window as any).__BLACKIYA_LOG_QUEUE__;
            expect(queue.length).toBe(100);
            expect(queue[0].message).toBe('msg-10'); // Old ones evicted
            expect(queue[99].message).toBe('msg-109');
        });

        it('should track dropped log entries in queue-drop stats', () => {
            const warn = mock(() => {});
            const originalWarn = console.warn;
            console.warn = warn;
            try {
                for (let i = 0; i < 110; i++) {
                    appendToLogQueue({
                        type: 'log',
                        level: 'info',
                        message: `msg-${i}`,
                        __blackiyaToken: 'token',
                    } as any);
                }
                expect(getCaptureQueueDropStats().logDropped).toBe(10);
                expect(warn).toHaveBeenCalledTimes(1);
            } finally {
                console.warn = originalWarn;
            }
        });
    });

    describe('appendToCaptureQueue and getRawCaptureHistory', () => {
        it('should append payload and history to window', () => {
            const payload = { url: 'http', platform: 'test', data: 'data', __blackiyaToken: 't' } as any;
            appendToCaptureQueue(payload);

            const queue = (globalThis.window as any).__BLACKIYA_CAPTURE_QUEUE__;
            expect(queue.length).toBe(1);
            expect(queue[0]).toBe(payload);

            const history = getRawCaptureHistory();
            expect(history.length).toBe(1);
            expect(history[0]).toEqual(payload);
        });

        it('should cap queues appropriately', () => {
            for (let i = 0; i < 60; i++) {
                appendToCaptureQueue({ url: 'http', platform: 'test', data: `${i}`, __blackiyaToken: 't' } as any);
            }

            const queue = (globalThis.window as any).__BLACKIYA_CAPTURE_QUEUE__;
            expect(queue.length).toBe(50); // MAX_CAPTURE_QUEUE_SIZE
            expect(queue[0].data).toBe('10');

            const history = getRawCaptureHistory();
            expect(history.length).toBe(30); // MAX_CAPTURE_HISTORY_SIZE
            expect(history[0].data).toBe('30');
            expect(history[29].data).toBe('59');
        });

        it('should track dropped capture/history entries in queue-drop stats', () => {
            const warn = mock(() => {});
            const originalWarn = console.warn;
            console.warn = warn;
            try {
                for (let i = 0; i < 60; i++) {
                    appendToCaptureQueue({ url: 'http', platform: 'test', data: `${i}`, __blackiyaToken: 't' } as any);
                }
                const stats = getCaptureQueueDropStats();
                expect(stats.captureDropped).toBe(10);
                expect(stats.historyDropped).toBe(30);
                expect(warn.mock.calls.length).toBeGreaterThan(0);
            } finally {
                console.warn = originalWarn;
            }
        });

        it('getRawCaptureHistory should return empty array if uninitialized or invalid', () => {
            expect(getRawCaptureHistory()).toEqual([]);
            (globalThis.window as any).__BLACKIYA_RAW_CAPTURE_HISTORY__ = 'not-array';
            expect(getRawCaptureHistory()).toEqual([]);
        });
    });
});
