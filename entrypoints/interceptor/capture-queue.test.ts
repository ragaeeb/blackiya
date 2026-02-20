import { beforeEach, describe, expect, it } from 'bun:test';
import { appendToCaptureQueue, appendToLogQueue, getRawCaptureHistory } from '@/entrypoints/interceptor/capture-queue';

describe('capture-queue', () => {
    beforeEach(() => {
        const win = globalThis.window as any;
        delete win.__BLACKIYA_LOG_QUEUE__;
        delete win.__BLACKIYA_CAPTURE_QUEUE__;
        delete win.__BLACKIYA_RAW_CAPTURE_HISTORY__;
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

        it('getRawCaptureHistory should return empty array if uninitialized or invalid', () => {
            expect(getRawCaptureHistory()).toEqual([]);
            (globalThis.window as any).__BLACKIYA_RAW_CAPTURE_HISTORY__ = 'not-array';
            expect(getRawCaptureHistory()).toEqual([]);
        });
    });
});
