import { describe, expect, it } from 'bun:test';
import { InMemoryProbeScheduler } from '@/utils/sfe/probe-scheduler';

describe('InMemoryProbeScheduler', () => {
    it('should report a task as running after start', () => {
        const scheduler = new InMemoryProbeScheduler();
        scheduler.start('attempt-1');
        expect(scheduler.isRunning('attempt-1')).toBeTrue();
    });

    it('should report a task as not running before it is started', () => {
        const scheduler = new InMemoryProbeScheduler();
        expect(scheduler.isRunning('attempt-1')).toBeFalse();
    });

    it('should return an AbortSignal from start that is initially not aborted', () => {
        const scheduler = new InMemoryProbeScheduler();
        const signal = scheduler.start('attempt-1');
        expect(signal.aborted).toBeFalse();
    });

    it('should cancel a running task and abort its signal', () => {
        const scheduler = new InMemoryProbeScheduler();
        const signal = scheduler.start('attempt-1');
        scheduler.cancel('attempt-1');
        expect(scheduler.isRunning('attempt-1')).toBeFalse();
        expect(signal.aborted).toBeTrue();
    });

    it('should cancel any existing task for the same attemptId when start is called again', () => {
        const scheduler = new InMemoryProbeScheduler();
        const firstSignal = scheduler.start('attempt-1');
        const secondSignal = scheduler.start('attempt-1');

        // The first signal must be aborted because start replaced it.
        expect(firstSignal.aborted).toBeTrue();
        // The new signal is live.
        expect(secondSignal.aborted).toBeFalse();
        expect(scheduler.isRunning('attempt-1')).toBeTrue();
    });

    it('should be a no-op when cancelling an attemptId that is not running', () => {
        const scheduler = new InMemoryProbeScheduler();
        expect(() => scheduler.cancel('nonexistent')).not.toThrow();
        expect(scheduler.isRunning('nonexistent')).toBeFalse();
    });

    it('should cancel all running tasks and abort their signals', () => {
        const scheduler = new InMemoryProbeScheduler();
        const s1 = scheduler.start('attempt-1');
        const s2 = scheduler.start('attempt-2');
        const s3 = scheduler.start('attempt-3');

        scheduler.cancelAll();

        expect(s1.aborted).toBeTrue();
        expect(s2.aborted).toBeTrue();
        expect(s3.aborted).toBeTrue();
        expect(scheduler.isRunning('attempt-1')).toBeFalse();
        expect(scheduler.isRunning('attempt-2')).toBeFalse();
        expect(scheduler.isRunning('attempt-3')).toBeFalse();
    });

    it('should allow starting a new task after cancelAll', () => {
        const scheduler = new InMemoryProbeScheduler();
        scheduler.start('attempt-1');
        scheduler.cancelAll();

        const newSignal = scheduler.start('attempt-1');
        expect(scheduler.isRunning('attempt-1')).toBeTrue();
        expect(newSignal.aborted).toBeFalse();
    });

    it('should track multiple independent attempts simultaneously', () => {
        const scheduler = new InMemoryProbeScheduler();
        scheduler.start('a');
        scheduler.start('b');

        expect(scheduler.isRunning('a')).toBeTrue();
        expect(scheduler.isRunning('b')).toBeTrue();

        scheduler.cancel('a');
        expect(scheduler.isRunning('a')).toBeFalse();
        expect(scheduler.isRunning('b')).toBeTrue();
    });
});
