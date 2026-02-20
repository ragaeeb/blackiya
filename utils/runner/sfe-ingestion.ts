/**
 * SFE (Signal Fusion Engine) ingestion — handles lifecycle signal ingestion
 * and canonical sample processing with retry scheduling.
 *
 * Dependencies are injected so the functions are unit-testable without a live
 * runner closure.
 */

import type { PlatformReadiness } from '@/platforms/types';
import { logger } from '@/utils/logger';
import type { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import type { ResponseLifecycleMessage } from '@/utils/protocol/messages';
import { shouldIngestAsCanonicalSample } from '@/utils/sfe/capture-fidelity';
import type { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';
import type { ExportMeta, LifecyclePhase } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

type LifecycleUiState = 'idle' | 'prompt-sent' | 'streaming' | 'completed';

export type SfeIngestionDeps = {
    sfeEnabled: boolean;
    sfe: SignalFusionEngine;
    platformName: string;
    resolveAttemptId: (conversationId?: string) => string;
    bindAttempt: (conversationId: string | undefined, attemptId: string) => void;
    evaluateReadiness: (data: ConversationData) => PlatformReadiness;
    getLifecycleState: () => LifecycleUiState;
    scheduleCanonicalStabilizationRetry: (conversationId: string, attemptId: string) => void;
    clearCanonicalStabilizationRetry: (attemptId: string) => void;
    syncStreamProbePanelFromCanonical: (conversationId: string, data: ConversationData) => void;
    refreshButtonState: (conversationId?: string) => void;
    structuredLogger: StructuredAttemptLogger;
};

/**
 * Maps a wire protocol lifecycle phase to its SFE equivalent and ingests it.
 * No-op for unrecognised phases.
 */
export const ingestSfeLifecycleFromWirePhase = (
    phase: ResponseLifecycleMessage['phase'],
    attemptId: string,
    conversationId: string | null | undefined,
    deps: SfeIngestionDeps,
) => {
    const mapping: Partial<Record<ResponseLifecycleMessage['phase'], LifecyclePhase>> = {
        'prompt-sent': 'prompt_sent',
        streaming: 'streaming',
        completed: 'completed_hint',
        terminated: 'terminated_partial',
    };
    const sfePhase = mapping[phase];
    if (sfePhase) {
        ingestSfeLifecycleSignal(sfePhase, attemptId, conversationId, deps);
    }
};

/**
 * Ingests a single SFE lifecycle signal, binding the attempt to its
 * conversation and emitting structured logs.
 */
export const ingestSfeLifecycleSignal = (
    phase: LifecyclePhase,
    attemptId: string,
    conversationId: string | null | undefined,
    deps: SfeIngestionDeps,
) => {
    if (!deps.sfeEnabled) {
        return;
    }
    const resolution = deps.sfe.ingestSignal({
        attemptId,
        platform: deps.platformName,
        source: phase === 'completed_hint' ? 'completion_endpoint' : 'network_stream',
        phase,
        conversationId,
        timestampMs: Date.now(),
    });
    if (conversationId) {
        deps.bindAttempt(conversationId, attemptId);
    }
    if (phase === 'completed_hint') {
        deps.structuredLogger.emit(
            attemptId,
            'info',
            'completed_hint_received',
            'SFE completed hint received',
            { conversationId: conversationId ?? null },
            `completed:${conversationId ?? 'unknown'}`,
        );
    }
    deps.structuredLogger.emit(
        attemptId,
        'debug',
        'sfe_phase_update',
        'SFE lifecycle phase update',
        { phase: resolution.phase, ready: resolution.ready, conversationId: conversationId ?? null },
        `phase:${resolution.phase}:${conversationId ?? 'unknown'}`,
    );
};

const shouldScheduleCanonicalRetry = (
    resolution: ReturnType<SignalFusionEngine['applyCanonicalSample']>,
    lifecycleState: LifecycleUiState,
): boolean => {
    const hitStabilizationTimeout = resolution.blockingConditions.includes('stabilization_timeout');
    return (
        !resolution.ready &&
        !hitStabilizationTimeout &&
        lifecycleState === 'completed' &&
        (resolution.reason === 'awaiting_stabilization' || resolution.reason === 'captured_not_ready')
    );
};

/**
 * Ingests a canonical data sample into SFE, scheduling stabilization retries
 * when not yet ready, and clearing them on terminal states.
 */
export const ingestSfeCanonicalSample = (
    data: ConversationData,
    attemptId: string | undefined,
    deps: SfeIngestionDeps,
): ReturnType<SignalFusionEngine['applyCanonicalSample']> | null => {
    if (!deps.sfeEnabled) {
        return null;
    }
    const conversationId = data.conversation_id;
    const effectiveAttemptId = attemptId ?? deps.resolveAttemptId(conversationId);
    deps.bindAttempt(conversationId, effectiveAttemptId);
    const readiness = deps.evaluateReadiness(data);
    const resolution = deps.sfe.applyCanonicalSample({
        attemptId: effectiveAttemptId,
        platform: deps.platformName,
        conversationId,
        data,
        readiness,
        timestampMs: Date.now(),
    });

    deps.structuredLogger.emit(
        effectiveAttemptId,
        'debug',
        readiness.contentHash ? 'canonical_probe_sample_changed' : 'canonical_probe_started',
        'SFE canonical sample processed',
        {
            conversationId,
            phase: resolution.phase,
            ready: resolution.ready,
            blockingConditions: resolution.blockingConditions,
        },
        `canonical:${conversationId}:${readiness.contentHash ?? 'none'}`,
    );

    const shouldRetry = shouldScheduleCanonicalRetry(resolution, deps.getLifecycleState());
    if (!shouldRetry && !resolution.ready) {
        logger.info('Canonical retry skipped', {
            conversationId,
            lifecycleState: deps.getLifecycleState(),
            reason: resolution.reason,
            blocking: resolution.blockingConditions,
        });
    }
    if (shouldRetry) {
        deps.scheduleCanonicalStabilizationRetry(conversationId, effectiveAttemptId);
        deps.structuredLogger.emit(
            effectiveAttemptId,
            'info',
            resolution.reason === 'awaiting_stabilization'
                ? 'awaiting_stabilization'
                : 'awaiting_canonical_capture',
            resolution.reason === 'awaiting_stabilization'
                ? 'Awaiting canonical stabilization before ready'
                : 'Completed stream but canonical sample not terminal yet; scheduling retries',
            { conversationId, phase: resolution.phase },
            `${resolution.reason === 'awaiting_stabilization' ? 'awaiting-stabilization' : 'awaiting-canonical'}:${conversationId}:${readiness.contentHash ?? 'none'}`,
        );
    }
    if (resolution.blockingConditions.includes('stabilization_timeout')) {
        deps.clearCanonicalStabilizationRetry(effectiveAttemptId);
    }
    if (resolution.ready) {
        deps.clearCanonicalStabilizationRetry(effectiveAttemptId);
        deps.syncStreamProbePanelFromCanonical(conversationId, data);
        deps.structuredLogger.emit(
            effectiveAttemptId,
            'info',
            'captured_ready',
            'Capture reached ready state',
            { conversationId, phase: resolution.phase },
            `captured-ready:${conversationId}`,
        );
    }
    return resolution;
};

/**
 * Returns `true` when the SFE reports the conversation as ready.
 */
export const resolveSfeReady = (
    conversationId: string,
    sfe: SignalFusionEngine,
): boolean => {
    const resolution = sfe.resolveByConversation(conversationId);
    return !!resolution?.ready;
};

/**
 * Logs a warning when legacy readiness disagrees with SFE readiness.
 */
export const logSfeMismatchIfNeeded = (
    conversationId: string,
    legacyReady: boolean,
    deps: Pick<SfeIngestionDeps, 'sfeEnabled' | 'sfe' | 'structuredLogger'> & {
        peekAttemptId: (cid: string) => string | null;
    },
) => {
    if (!deps.sfeEnabled) {
        return;
    }
    const attemptId = deps.peekAttemptId(conversationId) ?? 'unknown';
    const sfeReady = resolveSfeReady(conversationId, deps.sfe);
    if (legacyReady === sfeReady) {
        return;
    }
    deps.structuredLogger.emit(
        attemptId,
        'info',
        'legacy_sfe_mismatch',
        'Legacy/SFE readiness mismatch',
        { conversationId, legacyReady, sfeReady },
        `mismatch:${conversationId}:${legacyReady}:${sfeReady}`,
    );
};

/**
 * Emits an `ATTEMPT_DISPOSED` message and cleans up pending lifecycle state.
 */
export const emitAttemptDisposed = (
    attemptId: string,
    reason: 'superseded' | 'navigation' | 'teardown' | 'timeout',
    deps: {
        pendingLifecycleByAttempt: Map<string, unknown>;
        structuredLogger: StructuredAttemptLogger;
        postDisposedMessage: (attemptId: string, reason: string) => void;
    },
) => {
    deps.pendingLifecycleByAttempt.delete(attemptId);
    deps.structuredLogger.emit(
        attemptId,
        'info',
        'attempt_disposed',
        'Attempt disposed',
        { reason },
        `attempt-disposed:${reason}`,
    );
    deps.postDisposedMessage(attemptId, reason);
};

/**
 * Re-ingests a cached canonical sample into SFE when the capture metadata
 * indicates it hasn't been ingested yet.
 */
export const maybeReingestCachedCanonical = (
    cached: ConversationData | null,
    captureMeta: ExportMeta,
    attemptId: string | undefined,
    deps: SfeIngestionDeps,
) => {
    if (cached && shouldIngestAsCanonicalSample(captureMeta)) {
        ingestSfeCanonicalSample(cached, attemptId, deps);
    }
};
