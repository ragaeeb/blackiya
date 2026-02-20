export type CanonicalStabilizationAttemptState = {
    timerIds: Map<string, number>;
    retryCounts: Map<string, number>;
    startedAt: Map<string, number>;
    timeoutWarnings: Set<string>;
    inProgress: Set<string>;
};

export const beginCanonicalStabilizationTick = (attemptId: string, inProgress: Set<string>): boolean => {
    if (inProgress.has(attemptId)) {
        return false;
    }
    inProgress.add(attemptId);
    return true;
};

export const clearCanonicalStabilizationAttemptState = (
    attemptId: string,
    state: CanonicalStabilizationAttemptState,
    clearTimer: (timerId: number) => void = (timerId) => {
        clearTimeout(timerId);
    },
) => {
    const timerId = state.timerIds.get(attemptId);
    if (timerId !== undefined) {
        clearTimer(timerId);
    }
    state.timerIds.delete(attemptId);
    state.retryCounts.delete(attemptId);
    state.startedAt.delete(attemptId);
    state.timeoutWarnings.delete(attemptId);
    state.inProgress.delete(attemptId);
};

export const resolveShouldSkipCanonicalRetryAfterAwait = (
    attemptId: string,
    disposedOrSuperseded: boolean,
    mappedAttemptId: string | undefined,
    resolveAttemptId: (attemptId: string) => string,
): boolean => {
    if (disposedOrSuperseded) {
        return true;
    }
    if (!mappedAttemptId) {
        return false;
    }
    return resolveAttemptId(mappedAttemptId) !== resolveAttemptId(attemptId);
};
