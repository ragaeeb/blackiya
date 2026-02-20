import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { buildLoggerMock, createLoggerCalls } from '@/utils/runner/__tests__/helpers';
import {
    type CanonicalStabilizationTickDeps,
    clearCanonicalStabilizationRetry,
    hasCanonicalStabilizationTimedOut,
    maybeRestartCanonicalRecoveryAfterTimeout,
    scheduleCanonicalStabilizationRetry,
} from '@/utils/runner/canonical-stabilization-tick';
import type { ExportMeta } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

const logCalls = createLoggerCalls();
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));

describe('canonical-stabilization-tick', () => {
    let deps: CanonicalStabilizationTickDeps;
    let originalSetTimeout: typeof setTimeout;

    beforeEach(() => {
        logCalls.debug.length = 0;
        logCalls.info.length = 0;
        logCalls.warn.length = 0;
        logCalls.error.length = 0;

        (globalThis as any).window = globalThis;
        originalSetTimeout = globalThis.setTimeout;

        deps = {
            maxRetries: 5,
            retryDelayMs: 1000,
            timeoutGraceMs: 2000,
            retryTimers: new Map(),
            retryCounts: new Map(),
            startedAt: new Map(),
            timeoutWarnings: new Set(),
            inProgress: new Set(),
            attemptByConversation: new Map([['conv-1', 'attempt-1']]),

            isAttemptDisposedOrSuperseded: mock(() => false),
            resolveAliasedAttemptId: mock((id) => id),
            getSfePhase: mock(() => 'completed'),
            sfeRestartCanonicalRecovery: mock(() => true),

            warmFetch: mock(() => Promise.resolve(true)),
            requestSnapshot: mock(() => Promise.resolve(null)),
            buildIsolatedSnapshot: mock(() => null),
            ingestSnapshot: mock(() => {}),
            getConversation: mock(() => null),
            evaluateReadiness: mock(() => ({ ready: false, terminal: false, reason: 'none' }) as any),
            getCaptureMeta: mock(
                () =>
                    ({
                        captureSource: 'dom_snapshot_degraded',
                        fidelity: 'degraded',
                        completeness: 'partial',
                    }) as ExportMeta,
            ),
            ingestSfeCanonicalSample: mock(() => {}),
            markCanonicalCaptureMeta: mock(() => {}),
            refreshButtonState: mock(() => {}),

            emitWarn: mock(() => {}),
            emitInfo: mock(() => {}),
        };
    });

    afterEach(() => {
        globalThis.setTimeout = originalSetTimeout;
    });

    describe('hasCanonicalStabilizationTimedOut', () => {
        it('should return false if there is a pending timer', () => {
            deps.retryTimers.set('attempt-1', 123);
            expect(hasCanonicalStabilizationTimedOut('attempt-1', deps)).toBeFalse();
        });

        it('should return true if max retries exceeded and no timer pending', () => {
            deps.retryCounts.set('attempt-1', 6); // > 5
            expect(hasCanonicalStabilizationTimedOut('attempt-1', deps)).toBeTrue();
            expect(logCalls.info).toHaveLength(1);
        });

        it('should return false if not started yet', () => {
            deps.retryCounts.set('attempt-1', 0);
            expect(hasCanonicalStabilizationTimedOut('attempt-1', deps)).toBeFalse();
        });

        it('should return true if elapsed time exceeds max budget', () => {
            const now = Date.now();
            deps.startedAt.set('attempt-1', now - 10000); // Exceeds 5 * 1000 + 2000 = 7000
            expect(hasCanonicalStabilizationTimedOut('attempt-1', deps)).toBeTrue();
        });

        it('should return false if elapsed time is within budget', () => {
            const now = Date.now();
            deps.startedAt.set('attempt-1', now - 1000);
            expect(hasCanonicalStabilizationTimedOut('attempt-1', deps)).toBeFalse();
        });
    });

    describe('clearCanonicalStabilizationRetry', () => {
        it('should clear all attempt states', () => {
            deps.retryTimers.set('attempt-1', 123);
            deps.retryCounts.set('attempt-1', 1);
            deps.startedAt.set('attempt-1', 1000);
            deps.timeoutWarnings.add('attempt-1');
            deps.inProgress.add('attempt-1');

            clearCanonicalStabilizationRetry('attempt-1', deps);

            expect(deps.retryTimers.has('attempt-1')).toBeFalse();
            expect(deps.retryCounts.has('attempt-1')).toBeFalse();
            expect(deps.startedAt.has('attempt-1')).toBeFalse();
            expect(deps.timeoutWarnings.has('attempt-1')).toBeFalse();
            expect(deps.inProgress.has('attempt-1')).toBeFalse();
        });
    });

    describe('maybeRestartCanonicalRecoveryAfterTimeout', () => {
        it('should abort if not timed out', () => {
            maybeRestartCanonicalRecoveryAfterTimeout('conv-1', 'attempt-1', deps);
            expect(deps.sfeRestartCanonicalRecovery).not.toHaveBeenCalled();
        });

        it('should restart recovery and emit info if timed out', () => {
            deps.retryCounts.set('attempt-1', 6); // Timed out
            maybeRestartCanonicalRecoveryAfterTimeout('conv-1', 'attempt-1', deps);

            expect(deps.sfeRestartCanonicalRecovery).toHaveBeenCalled();
            expect(deps.emitInfo).toHaveBeenCalledWith(
                'attempt-1',
                'canonical_recovery_rearmed',
                expect.any(String),
                expect.any(Object),
                expect.any(String),
            );
        });
    });

    describe('scheduleCanonicalStabilizationRetry / Tick', () => {
        it('should handle skip if attempt is disposed or superseded', () => {
            deps.isAttemptDisposedOrSuperseded = () => true;
            scheduleCanonicalStabilizationRetry('conv-1', 'attempt-1', deps);
            expect(deps.retryTimers.has('attempt-1')).toBeFalse();
        });

        it('should set timer and trigger tick', async () => {
            let tickCallback: Function | undefined;
            globalThis.setTimeout = mock((fn) => {
                tickCallback = fn as Function;
                return 123 as any;
            }) as any;

            scheduleCanonicalStabilizationRetry('conv-1', 'attempt-1', deps);

            expect(deps.retryTimers.has('attempt-1')).toBeTrue();
            expect(deps.startedAt.has('attempt-1')).toBeTrue();

            // Run tick
            tickCallback!();

            // Because warmFetch resolves asynchronously, we need to await the next tick to ensure we assert properly
            await new Promise((res) => process.nextTick(res));

            expect(deps.warmFetch).toHaveBeenCalledWith('conv-1');
            // Since getConversation is null, it should schedule again
            expect(deps.retryTimers.has('attempt-1')).toBeTrue();
        });

        it('should trigger warnings if max retries exhausted', () => {
            deps.retryCounts.set('attempt-1', 5);
            scheduleCanonicalStabilizationRetry('conv-1', 'attempt-1', deps);
            expect(deps.emitWarn).toHaveBeenCalled();
            expect(deps.retryTimers.has('attempt-1')).toBeFalse();
        });

        it('should ingest canonical sample if capture meta is canonical', async () => {
            let tickCallback: Function | undefined;
            globalThis.setTimeout = mock((fn) => {
                tickCallback = fn as Function;
                return 123 as any;
            }) as any;

            deps.getConversation = () => ({}) as ConversationData;
            deps.getCaptureMeta = () =>
                ({ captureSource: 'canonical_api', fidelity: 'high', completeness: 'complete' }) as ExportMeta;

            scheduleCanonicalStabilizationRetry('conv-1', 'attempt-1', deps);
            tickCallback!();
            await new Promise((res) => process.nextTick(res));

            expect(deps.ingestSfeCanonicalSample).toHaveBeenCalled();
            expect(deps.refreshButtonState).toHaveBeenCalled();
            expect(deps.retryTimers.has('attempt-1')).toBeFalse(); // Does not loop again
        });

        it('should attempt promotion if API is unreachable and readily degraded data is in cache', async () => {
            let tickCallback: Function | undefined;
            globalThis.setTimeout = mock((fn) => {
                originalSetTimeout(() => (fn as Function)(), 0);
                return 123 as any;
            }) as any;

            deps.getConversation = () => ({}) as ConversationData;
            // degraded data
            deps.getCaptureMeta = () =>
                ({
                    captureSource: 'dom_snapshot_degraded',
                    fidelity: 'degraded',
                    completeness: 'partial',
                }) as ExportMeta;
            // API fetch failed
            deps.warmFetch = () => Promise.resolve(false);
            // Readily degraded
            deps.evaluateReadiness = () => ({ ready: true }) as any;

            scheduleCanonicalStabilizationRetry('conv-1', 'attempt-1', deps);
            // give it enough time to clear promises
            await new Promise((res) => globalThis.setTimeout(res, 10));

            expect(deps.markCanonicalCaptureMeta).toHaveBeenCalled();
            expect(deps.ingestSfeCanonicalSample).toHaveBeenCalled();
        });

        it('should abort if already in progress to avoid overlapping ticks', async () => {
            deps.inProgress.add('attempt-1');
            let tickCallback: Function | undefined;
            globalThis.setTimeout = mock((fn) => {
                tickCallback = fn as Function;
                return 123 as any;
            }) as any;

            scheduleCanonicalStabilizationRetry('conv-1', 'attempt-1', deps);

            expect(deps.retryTimers.has('attempt-1')).toBeTrue();
            tickCallback!();

            await new Promise((res) => process.nextTick(res));

            expect(deps.warmFetch).not.toHaveBeenCalled();
        });

        it('should promote refresh snapshot if ready and fetch succeeds but capture meta is degraded', async () => {
            let tickCallback: Function | undefined;
            globalThis.setTimeout = mock((fn) => {
                originalSetTimeout(() => (fn as Function)(), 0);
                return 123 as any;
            }) as any;

            let callCount = 0;
            deps.getConversation = () => {
                return callCount++ > 0 ? ({} as ConversationData) : null;
            };
            deps.getCaptureMeta = () =>
                ({
                    captureSource: 'dom_snapshot_degraded',
                    fidelity: 'degraded',
                    completeness: 'partial',
                }) as ExportMeta;
            deps.warmFetch = () => Promise.resolve(false);
            deps.evaluateReadiness = mock((data) => ({ ready: !!data }) as any);
            deps.requestSnapshot = mock(() => Promise.resolve({} as ConversationData));

            deps.getConversation = mock(() => ({}) as ConversationData);
            deps.evaluateReadiness = mock((data) => ({ ready: false }) as any)
                .mockImplementationOnce(() => ({ ready: false }) as any) // Initial degraded readiness -> goes to tryRefresh
                .mockImplementationOnce(() => ({ ready: true }) as any); // Second pass when validating fresh snapshot

            scheduleCanonicalStabilizationRetry('conv-1', 'attempt-1', deps);
            await new Promise((res) => globalThis.setTimeout(res, 20));

            expect(deps.requestSnapshot).toHaveBeenCalled();
            expect(deps.ingestSnapshot).toHaveBeenCalled();
            expect(deps.markCanonicalCaptureMeta).toHaveBeenCalled();
        });
    });
});
