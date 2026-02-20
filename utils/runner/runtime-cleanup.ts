import { logger } from '@/utils/logger';

type CleanupReason = 'teardown';

const clearTimeoutMap = <K>(timers: Map<K, number>) => {
    for (const timerId of timers.values()) {
        clearTimeout(timerId);
    }
    timers.clear();
};

const abortControllers = <K>(controllers: Map<K, AbortController>) => {
    for (const controller of controllers.values()) {
        try {
            controller.abort();
        } catch {
            // noop
        }
    }
    controllers.clear();
};

export type RunnerCleanupDeps = {
    isCleanedUp: () => boolean;
    markCleanedUp: () => void;
    removeVisibilityChangeListener: () => void;

    disposeAllAttempts: () => string[];
    handleDisposedAttempt: (attemptId: string, reason: CleanupReason) => void;

    stopInterceptionManager: () => void;
    stopNavigationManager: () => void;
    removeButtons: () => void;

    cleanupWindowBridge: (() => void) | null;
    cleanupCompletionWatcher: (() => void) | null;
    cleanupButtonHealthCheck: (() => void) | null;
    removeStorageChangeListener: () => void;

    autoCaptureRetryTimers: Map<string, number>;
    canonicalStabilizationRetryTimers: Map<string, number>;
    canonicalStabilizationRetryCounts: Map<string, number>;
    canonicalStabilizationStartedAt: Map<string, number>;
    timeoutWarningByAttempt: Set<string>;
    canonicalStabilizationInProgress: Set<string>;
    probeLeaseRetryTimers: Map<string, number>;
    streamProbeControllers: Map<string, AbortController>;
    disposeProbeLease: () => void;
    retryTimeoutIds: number[];
    autoCaptureDeferredLogged: Set<string>;

    beforeUnloadHandlerRef: { value: (() => void) | null };
    removeBeforeUnloadListener: (handler: () => void) => void;
    clearRunnerControl: () => void;
};

export const createCleanupRuntime = (deps: RunnerCleanupDeps) => {
    return () => {
        if (deps.isCleanedUp()) {
            return;
        }
        deps.markCleanedUp();
        try {
            deps.removeVisibilityChangeListener();

            const disposed = deps.disposeAllAttempts();
            for (const attemptId of disposed) {
                deps.handleDisposedAttempt(attemptId, 'teardown');
            }

            deps.stopInterceptionManager();
            deps.stopNavigationManager();
            deps.removeButtons();

            deps.cleanupWindowBridge?.();
            deps.cleanupCompletionWatcher?.();
            deps.cleanupButtonHealthCheck?.();
            deps.removeStorageChangeListener();

            clearTimeoutMap(deps.autoCaptureRetryTimers);
            clearTimeoutMap(deps.canonicalStabilizationRetryTimers);
            deps.canonicalStabilizationRetryCounts.clear();
            deps.canonicalStabilizationStartedAt.clear();
            deps.timeoutWarningByAttempt.clear();
            deps.canonicalStabilizationInProgress.clear();

            clearTimeoutMap(deps.probeLeaseRetryTimers);
            abortControllers(deps.streamProbeControllers);
            deps.disposeProbeLease();

            for (const timeoutId of deps.retryTimeoutIds) {
                clearTimeout(timeoutId);
            }
            deps.retryTimeoutIds.length = 0;
            deps.autoCaptureDeferredLogged.clear();

            const beforeUnloadHandler = deps.beforeUnloadHandlerRef.value;
            if (beforeUnloadHandler) {
                deps.removeBeforeUnloadListener(beforeUnloadHandler);
                deps.beforeUnloadHandlerRef.value = null;
            }

            deps.clearRunnerControl();
        } catch (error) {
            logger.debug('Error during cleanup:', error);
        }
    };
};
