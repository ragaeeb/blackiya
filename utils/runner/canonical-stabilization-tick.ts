/**
 * Canonical stabilization orchestration — schedules and processes retry ticks
 * that wait for the interception cache to reach a canonical-ready state after
 * a response stream completes.
 *
 * All dependencies are injected so the module is unit-testable in isolation.
 * Internal functions (`processCanonicalStabilizationRetryTick` and helpers) are
 * not exported; callers interact through `scheduleCanonicalStabilizationRetry`,
 * `clearCanonicalStabilizationRetry`, and `hasCanonicalStabilizationTimedOut`.
 */

import type { PlatformReadiness } from '@/platforms/types';
import { logger } from '@/utils/logger';
import {
    beginCanonicalStabilizationTick,
    clearCanonicalStabilizationAttemptState,
    resolveShouldSkipCanonicalRetryAfterAwait,
} from '@/utils/runner/canonical-stabilization';
import { shouldIngestAsCanonicalSample } from '@/utils/sfe/capture-fidelity';
import type { ExportMeta } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

// Deps

export type CanonicalStabilizationTickDeps = {
    // Constants
    maxRetries: number;
    retryDelayMs: number;
    timeoutGraceMs: number;
    // Mutable state maps (mutated in place by the orchestrator)
    retryTimers: Map<string, number>;
    retryCounts: Map<string, number>;
    startedAt: Map<string, number>;
    timeoutWarnings: Set<string>;
    inProgress: Set<string>;
    attemptByConversation: Map<string, string>;
    // Lifecycle / SFE
    isAttemptDisposedOrSuperseded: (attemptId: string) => boolean;
    resolveAliasedAttemptId: (attemptId: string) => string;
    /** Returns the SFE phase string for diagnostic logging only. */
    getSfePhase: (attemptId: string) => string;
    sfeRestartCanonicalRecovery: (attemptId: string, now: number) => boolean;
    // Data access
    warmFetch: (conversationId: string) => Promise<boolean>;
    requestSnapshot: (conversationId: string) => Promise<unknown | null>;
    buildIsolatedSnapshot: (conversationId: string) => ConversationData | null;
    /** Ingest a snapshot (ConversationData or raw bytes) into the interception cache. */
    ingestSnapshot: (conversationId: string, data: unknown) => void;
    getConversation: (conversationId: string) => ConversationData | null;
    evaluateReadiness: (data: ConversationData) => PlatformReadiness;
    getCaptureMeta: (conversationId: string) => ExportMeta;
    ingestSfeCanonicalSample: (data: ConversationData, attemptId: string) => void;
    markCanonicalCaptureMeta: (conversationId: string) => void;
    refreshButtonState: (conversationId: string) => void;
    // Structured logging
    emitWarn: (
        attemptId: string,
        event: string,
        message: string,
        payload: Record<string, unknown>,
        dedupeKey: string,
    ) => void;
    emitInfo: (
        attemptId: string,
        event: string,
        message: string,
        payload: Record<string, unknown>,
        dedupeKey: string,
    ) => void;
};

// Public helpers

/**
 * Returns `true` when canonical stabilization retries for this attempt have
 * exhausted either the max-retry count or the elapsed-time budget.
 */
export const hasCanonicalStabilizationTimedOut = (
    attemptId: string,
    deps: Pick<
        CanonicalStabilizationTickDeps,
        | 'maxRetries'
        | 'retryDelayMs'
        | 'timeoutGraceMs'
        | 'retryTimers'
        | 'retryCounts'
        | 'startedAt'
        | 'timeoutWarnings'
    >,
): boolean => {
    const retries = deps.retryCounts.get(attemptId) ?? 0;
    const hasPendingTimer = deps.retryTimers.has(attemptId);
    if (retries >= deps.maxRetries && !hasPendingTimer) {
        if (!deps.timeoutWarnings.has(attemptId)) {
            logger.info('Timeout: max retries exhausted with no pending timer', {
                attemptId,
                retries,
                hasPendingTimer,
                maxRetries: deps.maxRetries,
            });
        }
        return true;
    }
    if (hasPendingTimer) {
        return false;
    }
    const startedAt = deps.startedAt.get(attemptId);
    if (!startedAt) {
        return false;
    }
    const timeoutMs = deps.retryDelayMs * deps.maxRetries + deps.timeoutGraceMs;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs && !deps.timeoutWarnings.has(attemptId)) {
        logger.info('Timeout: elapsed exceeded max wait', { attemptId, retries, elapsed, timeoutMs });
    }
    return elapsed >= timeoutMs;
};

/**
 * Clears all stabilization state for an attempt, cancelling any pending timer.
 * Safe to call on attempts with no active stabilization.
 */
export const clearCanonicalStabilizationRetry = (
    attemptId: string,
    deps: Pick<
        CanonicalStabilizationTickDeps,
        'retryTimers' | 'retryCounts' | 'startedAt' | 'timeoutWarnings' | 'inProgress'
    >,
): void => {
    const hadTimer = deps.retryTimers.has(attemptId);
    if (hadTimer) {
        logger.info('Stabilization retry cleared', { attemptId });
    }
    clearCanonicalStabilizationAttemptState(attemptId, {
        timerIds: deps.retryTimers,
        retryCounts: deps.retryCounts,
        startedAt: deps.startedAt,
        timeoutWarnings: deps.timeoutWarnings,
        inProgress: deps.inProgress,
    });
};

/**
 * When a late canonical capture arrives after stabilization has timed out,
 * resets the timeout and re-arms the SFE recovery path.
 */
export const maybeRestartCanonicalRecoveryAfterTimeout = (
    conversationId: string,
    attemptId: string,
    deps: CanonicalStabilizationTickDeps,
): void => {
    if (!hasCanonicalStabilizationTimedOut(attemptId, deps)) {
        return;
    }
    clearCanonicalStabilizationRetry(attemptId, deps);
    const restarted = deps.sfeRestartCanonicalRecovery(attemptId, Date.now());
    if (!restarted) {
        return;
    }
    deps.emitInfo(
        attemptId,
        'canonical_recovery_rearmed',
        'Re-armed canonical stabilization after timeout due to late canonical capture',
        { conversationId },
        `canonical-recovery-rearmed:${conversationId}`,
    );
};

// Internal tick helpers

/**
 * When the cache already holds a ready snapshot but the API was unreachable,
 * promotes that snapshot to canonical fidelity and schedules another retry
 * to confirm stabilization.
 */
const tryPromoteReadySnapshotAsCanonical = async (
    conversationId: string,
    attemptId: string,
    retries: number,
    fetchSucceeded: boolean,
    readiness: PlatformReadiness,
    deps: CanonicalStabilizationTickDeps,
): Promise<boolean> => {
    if (fetchSucceeded || !readiness.ready) {
        return false;
    }
    logger.info('Promoting ready snapshot to canonical (API unreachable)', {
        conversationId,
        retries: retries + 1,
    });
    deps.markCanonicalCaptureMeta(conversationId);
    const cached = deps.getConversation(conversationId);
    if (!cached) {
        return false;
    }
    deps.ingestSfeCanonicalSample(cached, attemptId);
    scheduleCanonicalStabilizationRetry(conversationId, attemptId, deps);
    deps.refreshButtonState(conversationId);
    return true;
};

/**
 * When the cached snapshot is not yet ready, re-requests a fresh snapshot,
 * ingests it, and promotes it to canonical if it passes the readiness check.
 */
const tryRefreshDegradedSnapshotAndPromote = async (
    conversationId: string,
    attemptId: string,
    retries: number,
    fetchSucceeded: boolean,
    readiness: PlatformReadiness,
    deps: CanonicalStabilizationTickDeps,
): Promise<boolean> => {
    if (fetchSucceeded || readiness.ready) {
        return false;
    }
    logger.info('Snapshot promotion skipped: readiness check failed, re-requesting snapshot', {
        conversationId,
        retries: retries + 1,
        reason: readiness.reason,
        terminal: readiness.terminal,
    });
    const freshSnapshot = await deps.requestSnapshot(conversationId);
    const freshData = freshSnapshot ?? deps.buildIsolatedSnapshot(conversationId);
    if (!freshData) {
        return false;
    }
    deps.ingestSnapshot(conversationId, freshData);
    const cached = deps.getConversation(conversationId);
    if (!cached || !deps.evaluateReadiness(cached).ready) {
        return false;
    }
    logger.info('Fresh snapshot promoted to canonical after re-request', { conversationId, retries: retries + 1 });
    deps.markCanonicalCaptureMeta(conversationId);
    deps.ingestSfeCanonicalSample(cached, attemptId);
    scheduleCanonicalStabilizationRetry(conversationId, attemptId, deps);
    deps.refreshButtonState(conversationId);
    return true;
};

/**
 * Handles the case where the existing cache is degraded (snapshot-sourced).
 * Attempts to promote it or refresh it; falls back to scheduling another retry.
 */
const handleDegradedCanonicalCandidate = async (
    conversationId: string,
    attemptId: string,
    retries: number,
    fetchSucceeded: boolean,
    cached: ConversationData,
    deps: CanonicalStabilizationTickDeps,
): Promise<void> => {
    const readiness = deps.evaluateReadiness(cached);
    if (await tryPromoteReadySnapshotAsCanonical(conversationId, attemptId, retries, fetchSucceeded, readiness, deps)) {
        return;
    }
    if (
        await tryRefreshDegradedSnapshotAndPromote(conversationId, attemptId, retries, fetchSucceeded, readiness, deps)
    ) {
        return;
    }
    scheduleCanonicalStabilizationRetry(conversationId, attemptId, deps);
    deps.refreshButtonState(conversationId);
};

const shouldSkipCanonicalRetryTick = (
    conversationId: string,
    attemptId: string,
    retries: number,
    deps: CanonicalStabilizationTickDeps,
): boolean => {
    const disposed = deps.isAttemptDisposedOrSuperseded(attemptId);
    const mappedAttempt = deps.attemptByConversation.get(conversationId);
    const mappedMismatch = !!mappedAttempt && mappedAttempt !== attemptId;
    logger.debug('Stabilization retry tick', {
        conversationId,
        attemptId,
        retries,
        disposed,
        mappedMismatch,
        sfePhase: deps.getSfePhase(attemptId),
    });
    return disposed || mappedMismatch;
};

const shouldSkipCanonicalRetryAfterAwait = (
    conversationId: string,
    attemptId: string,
    deps: CanonicalStabilizationTickDeps,
): boolean => {
    const mappedAttempt = deps.attemptByConversation.get(conversationId);
    const disposedOrSuperseded = deps.isAttemptDisposedOrSuperseded(attemptId);
    const shouldSkip = resolveShouldSkipCanonicalRetryAfterAwait(
        attemptId,
        disposedOrSuperseded,
        mappedAttempt,
        deps.resolveAliasedAttemptId,
    );
    if (!shouldSkip) {
        return false;
    }
    logger.debug('Stabilization retry skip after await', {
        conversationId,
        attemptId,
        disposedOrSuperseded,
        mappedAttempt: mappedAttempt ?? null,
    });
    return true;
};

// Core tick / schedule (mutually recursive — both defined in this module)

const processCanonicalStabilizationRetryTick = async (
    conversationId: string,
    attemptId: string,
    retries: number,
    deps: CanonicalStabilizationTickDeps,
): Promise<void> => {
    if (!beginCanonicalStabilizationTick(attemptId, deps.inProgress)) {
        logger.debug('Stabilization retry tick skipped: already in progress', { conversationId, attemptId });
        return;
    }
    try {
        deps.retryTimers.delete(attemptId);
        deps.retryCounts.set(attemptId, retries + 1);
        if (shouldSkipCanonicalRetryTick(conversationId, attemptId, retries, deps)) {
            return;
        }
        const fetchSucceeded = await deps.warmFetch(conversationId);
        if (shouldSkipCanonicalRetryAfterAwait(conversationId, attemptId, deps)) {
            return;
        }
        const cached = deps.getConversation(conversationId);
        if (!cached) {
            scheduleCanonicalStabilizationRetry(conversationId, attemptId, deps);
            return;
        }
        const captureMeta = deps.getCaptureMeta(conversationId);
        if (!shouldIngestAsCanonicalSample(captureMeta)) {
            await handleDegradedCanonicalCandidate(conversationId, attemptId, retries, fetchSucceeded, cached, deps);
            // Re-check after async work — attempt may have been superseded.
            if (shouldSkipCanonicalRetryAfterAwait(conversationId, attemptId, deps)) {
                return;
            }
            return;
        }
        deps.ingestSfeCanonicalSample(cached, attemptId);
        deps.refreshButtonState(conversationId);
    } finally {
        deps.inProgress.delete(attemptId);
    }
};

/**
 * Schedules the next canonical stabilization retry for the given attempt.
 * No-ops when a timer is already pending, the attempt is disposed/superseded,
 * or the max retry count is exhausted.
 */
export const scheduleCanonicalStabilizationRetry = (
    conversationId: string,
    attemptId: string,
    deps: CanonicalStabilizationTickDeps,
): void => {
    if (deps.retryTimers.has(attemptId)) {
        logger.debug('Stabilization retry already scheduled (skip)', { conversationId, attemptId });
        return;
    }
    if (deps.isAttemptDisposedOrSuperseded(attemptId)) {
        logger.debug('Stabilization retry skip: attempt disposed/superseded', { conversationId, attemptId });
        return;
    }
    const retries = deps.retryCounts.get(attemptId) ?? 0;
    if (retries >= deps.maxRetries) {
        deps.emitWarn(
            attemptId,
            'canonical_stabilization_retry_exhausted',
            'Canonical stabilization retries exhausted',
            { conversationId, retries },
            `canonical-stability-exhausted:${conversationId}:${retries}`,
        );
        return;
    }
    if (!deps.startedAt.has(attemptId)) {
        deps.startedAt.set(attemptId, Date.now());
    }
    const timerId = window.setTimeout(() => {
        void processCanonicalStabilizationRetryTick(conversationId, attemptId, retries, deps);
    }, deps.retryDelayMs);
    deps.retryTimers.set(attemptId, timerId);
    logger.debug('Stabilization retry scheduled', {
        conversationId,
        attemptId,
        retryNumber: retries + 1,
        delayMs: deps.retryDelayMs,
    });
};
