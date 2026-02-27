import { describe, expect, it, mock } from 'bun:test';
import { createCleanupRuntime, type RunnerCleanupDeps } from '@/utils/runner/runtime-cleanup';

describe('runtime-cleanup', () => {
    it('should run cleanup routines exactly once', () => {
        let isCleanedUp = false;
        const markCleanedUpMock = mock(() => {
            isCleanedUp = true;
        });
        const disposeAllAttemptsMock = mock(() => ['attempt-1']);
        const handleDisposedAttemptMock = mock(() => {});
        const controller = new AbortController();
        const abortMock = mock(() => controller.abort());
        controller.abort = abortMock;

        const maps = {
            autoCaptureRetryTimers: new Map([['a', 1 as any]]),
            canonicalStabilizationRetryTimers: new Map([['b', 2 as any]]),
            canonicalStabilizationRetryCounts: new Map([['c', 3]]),
            canonicalStabilizationStartedAt: new Map([['d', 4]]),
            streamProbeControllers: new Map([['e', controller]]),
            probeLeaseRetryTimers: new Map(),
        };

        const sets = {
            timeoutWarningByAttempt: new Set(['a']),
            canonicalStabilizationInProgress: new Set(['a']),
            autoCaptureDeferredLogged: new Set(['b']),
        };

        const deps: RunnerCleanupDeps = {
            isCleanedUp: () => isCleanedUp,
            markCleanedUp: markCleanedUpMock,
            removeVisibilityChangeListener: mock(() => {}),
            disposeAllAttempts: disposeAllAttemptsMock,
            handleDisposedAttempt: handleDisposedAttemptMock,
            stopInterceptionManager: mock(() => {}),
            stopNavigationManager: mock(() => {}),
            removeButtons: mock(() => {}),
            cleanupWindowBridge: mock(() => {}),
            cleanupCompletionWatcher: mock(() => {}),
            cleanupButtonHealthCheck: mock(() => {}),
            cleanupTabDebugRuntimeListener: mock(() => {}),
            removeStorageChangeListener: mock(() => {}),
            ...maps,
            ...sets,
            disposeProbeLease: mock(() => {}),
            retryTimeoutIds: [999 as any],
            beforeUnloadHandlerRef: { value: mock(() => {}) },
            removeBeforeUnloadListener: mock(() => {}),
            clearRunnerControl: mock(() => {}),
        };

        const cleanup = createCleanupRuntime(deps);
        cleanup();

        expect(markCleanedUpMock).toHaveBeenCalled();
        expect(deps.removeVisibilityChangeListener).toHaveBeenCalled();
        expect(disposeAllAttemptsMock).toHaveBeenCalled();
        expect(handleDisposedAttemptMock).toHaveBeenCalledWith('attempt-1', 'teardown');
        expect(deps.stopInterceptionManager).toHaveBeenCalled();
        expect(deps.cleanupWindowBridge).toHaveBeenCalled();
        expect(abortMock).toHaveBeenCalled();
        expect(maps.autoCaptureRetryTimers.size).toBe(0);
        expect(sets.timeoutWarningByAttempt.size).toBe(0);
        expect(deps.retryTimeoutIds.length).toBe(0);
        expect(deps.beforeUnloadHandlerRef.value).toBeNull();
        expect(deps.removeBeforeUnloadListener).toHaveBeenCalled();

        // Call again should do nothing
        cleanup();
        expect(markCleanedUpMock).toHaveBeenCalledTimes(1);
    });
});
