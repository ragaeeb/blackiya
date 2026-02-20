import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { LLMPlatform } from '@/platforms/types';
import { buildLoggerMock, createLoggerCalls } from '@/utils/runner/__tests__/helpers';
import { type AutoCaptureDeps, maybeRunAutoCapture, shouldSkipAutoCapture } from '@/utils/runner/auto-capture';

const logCalls = createLoggerCalls();
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));

describe('auto-capture', () => {
    let deps: AutoCaptureDeps;
    let originalSetTimeout: typeof setTimeout;
    let setTimeoutMock: ReturnType<typeof mock>;

    beforeEach(() => {
        logCalls.debug.length = 0;
        logCalls.info.length = 0;
        logCalls.warn.length = 0;
        logCalls.error.length = 0;

        (globalThis as any).window = globalThis;
        originalSetTimeout = globalThis.setTimeout;
        setTimeoutMock = mock(() => 123 as any);
        globalThis.setTimeout = setTimeoutMock as any;

        deps = {
            getAdapter: mock(() => ({ name: 'ChatGPT' }) as LLMPlatform),
            getCalibrationState: mock(() => 'idle' as const),
            isConversationReadyForActions: mock(() => false),
            isPlatformGenerating: mock(() => false),
            peekAttemptId: mock(() => 'attempt-1'),
            resolveAttemptId: mock(() => 'attempt-1'),
            getRememberedPreferredStep: mock(() => 'page-snapshot' as const),
            isCalibrationPreferenceLoaded: mock(() => true),
            ensureCalibrationPreferenceLoaded: mock(() => Promise.resolve()),
            runCalibrationCapture: mock(() => Promise.resolve()),
            autoCaptureAttempts: new Map(),
            autoCaptureRetryTimers: new Map(),
            autoCaptureDeferredLogged: new Set(),
            maxKeys: 100,
        };
    });

    afterEach(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    describe('shouldSkipAutoCapture', () => {
        it('should return true if adapter is missing', () => {
            deps.getAdapter = () => null;
            expect(shouldSkipAutoCapture('conv-1', deps)).toBeTrue();
        });

        it('should return true if calibration state is not idle', () => {
            deps.getCalibrationState = () => 'capturing';
            expect(shouldSkipAutoCapture('conv-1', deps)).toBeTrue();
        });

        it('should return true if conversation is already ready', () => {
            deps.isConversationReadyForActions = () => true;
            expect(shouldSkipAutoCapture('conv-1', deps)).toBeTrue();
        });

        it('should return false when all conditions are met', () => {
            expect(shouldSkipAutoCapture('conv-1', deps)).toBeFalse();
        });
    });

    describe('maybeRunAutoCapture', () => {
        it('should not run if shouldSkipAutoCapture is true', () => {
            deps.getAdapter = () => null;
            maybeRunAutoCapture('conv-1', 'response-finished', deps);
            expect(deps.runCalibrationCapture).not.toHaveBeenCalled();
        });

        it('should defer capture for ChatGPT when generating', () => {
            deps.isPlatformGenerating = () => true;
            maybeRunAutoCapture('conv-1', 'response-finished', deps);

            expect(setTimeoutMock).toHaveBeenCalled();
            expect(deps.autoCaptureDeferredLogged.has('attempt-1')).toBeTrue();
            expect(deps.runCalibrationCapture).not.toHaveBeenCalled();
            expect(logCalls.info).toHaveLength(1);
        });

        it('should resolve attempt if peekAttemptId is null and ChatGPT is generating', () => {
            deps.isPlatformGenerating = () => true;
            deps.peekAttemptId = () => null;
            deps.resolveAttemptId = mock(() => 'attempt-2');

            maybeRunAutoCapture('conv-1', 'response-finished', deps);

            expect(deps.resolveAttemptId).toHaveBeenCalledWith('conv-1');
            expect(setTimeoutMock).toHaveBeenCalled();
        });

        it('should not log deferred multiple times for the same attempt', () => {
            deps.isPlatformGenerating = () => true;
            deps.autoCaptureDeferredLogged.add('attempt-1');

            maybeRunAutoCapture('conv-1', 'response-finished', deps);

            expect(deps.autoCaptureDeferredLogged.size).toBe(1);
            expect(logCalls.info).toHaveLength(0); // already logged
        });

        it('should run auto capture if conditions are met and throttling is clear', () => {
            maybeRunAutoCapture('conv-1', 'response-finished', deps);

            expect(deps.runCalibrationCapture).toHaveBeenCalledWith('auto', 'conv-1');
            expect(logCalls.info).toHaveLength(1);
        });

        it('should throttle repeated auto captures within 12s for the same attempt', () => {
            maybeRunAutoCapture('conv-1', 'response-finished', deps);
            expect(deps.runCalibrationCapture).toHaveBeenCalledTimes(1);

            maybeRunAutoCapture('conv-1', 'response-finished', deps);
            expect(deps.runCalibrationCapture).toHaveBeenCalledTimes(1); // Throttled
        });

        it('should delete deferred logged entry when auto capturing', () => {
            deps.autoCaptureDeferredLogged.add('attempt-1');
            maybeRunAutoCapture('conv-1', 'response-finished', deps);

            expect(deps.autoCaptureDeferredLogged.has('attempt-1')).toBeFalse();
        });

        it('should load preferences and then run if preferred step is not loaded but loaded flag is false', async () => {
            deps.getRememberedPreferredStep = () => null;
            deps.isCalibrationPreferenceLoaded = () => false;

            let resolvePreference: () => void;
            const preferencePromise = new Promise<void>((res) => {
                resolvePreference = res;
            });
            deps.ensureCalibrationPreferenceLoaded = mock(() => preferencePromise);

            maybeRunAutoCapture('conv-1', 'response-finished', deps);

            expect(deps.ensureCalibrationPreferenceLoaded).toHaveBeenCalledWith('ChatGPT');
            expect(deps.runCalibrationCapture).not.toHaveBeenCalled();

            deps.getRememberedPreferredStep = () => 'page-snapshot' as const;
            resolvePreference!();

            await new Promise((res) => process.nextTick(res));

            expect(deps.runCalibrationCapture).toHaveBeenCalledWith('auto', 'conv-1');
        });

        it('should do nothing if preferences load but no adapter found during callback', async () => {
            deps.getRememberedPreferredStep = () => null;
            deps.isCalibrationPreferenceLoaded = () => false;

            deps.ensureCalibrationPreferenceLoaded = mock(() => Promise.resolve());

            maybeRunAutoCapture('conv-1', 'response-finished', deps);

            // simulate adapter going away
            deps.getAdapter = () => null;

            await new Promise((res) => process.nextTick(res));

            expect(deps.runCalibrationCapture).not.toHaveBeenCalled();
        });

        it('should not setup a deferred timer if one already exists', () => {
            deps.isPlatformGenerating = () => true;
            deps.autoCaptureRetryTimers.set('attempt-1', 999);

            maybeRunAutoCapture('conv-1', 'response-finished', deps);

            expect(setTimeoutMock).not.toHaveBeenCalled();
        });

        it('should fire the deferred timer callback and execute maybeRunAutoCapture again', () => {
            deps.isPlatformGenerating = () => true;

            let timerCallback: Function | null = null;
            globalThis.setTimeout = mock((fn: Function) => {
                timerCallback = fn;
                return 123 as any;
            }) as any;

            maybeRunAutoCapture('conv-1', 'response-finished', deps);

            expect(timerCallback).not.toBeNull();
            expect(deps.autoCaptureRetryTimers.get('attempt-1')).toBe(123);

            // Advance state so it stops generating
            deps.isPlatformGenerating = () => false;

            timerCallback!();

            expect(deps.autoCaptureRetryTimers.has('attempt-1')).toBeFalse();
            expect(deps.runCalibrationCapture).toHaveBeenCalledWith('auto', 'conv-1');
        });
    });
});
