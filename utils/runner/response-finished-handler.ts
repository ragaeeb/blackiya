/**
 * Response-finished signal handling — debounce, lifecycle promotion, and
 * post-completion orchestration (probe, button refresh, auto-capture).
 *
 * Dependencies are injected so the module is unit-testable without a live
 * runner closure.
 */

import { logger } from '@/utils/logger';
import type { PlatformReadiness } from '@/platforms/types';
import { resolveFinishedSignalDebounce } from '@/utils/runner/finished-signal';
import { shouldPromoteGrokFromCanonicalCapture } from '@/utils/runner/finished-signal';
import type { AutoCaptureReason } from '@/utils/runner/auto-capture';
import type { RunnerCalibrationUiState, RunnerLifecycleUiState } from '@/utils/runner/state';
import type { LifecyclePhase } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

export type ResponseFinishedDeps = {
    extractConversationIdFromUrl: () => string | null;
    getCurrentConversationId: () => string | null;
    peekAttemptId: (conversationId?: string) => string | null;
    resolveAttemptId: (conversationId?: string) => string;
    setActiveAttempt: (attemptId: string) => void;
    setCurrentConversation: (id: string) => void;
    bindAttempt: (conversationId: string, attemptId: string) => void;
    ingestSfeLifecycle: (phase: LifecyclePhase, attemptId: string, conversationId: string | null) => void;
    getCalibrationState: () => RunnerCalibrationUiState;
    shouldBlockActionsForGeneration: (conversationId: string) => boolean;
    adapterName: () => string | null;

    getLastResponseFinished: () => {
        at: number;
        conversationId: string | null;
        attemptId: string | null;
    };
    setLastResponseFinished: (at: number, conversationId: string | null, attemptId: string | null) => void;

    getConversation: (conversationId: string) => ConversationData | undefined;
    evaluateReadiness: (data: ConversationData) => PlatformReadiness;
    getLifecycleState: () => RunnerLifecycleUiState;
    setCompletedLifecycleState: (conversationId: string, attemptId: string) => void;
    runStreamDoneProbe: (conversationId: string, attemptId: string) => Promise<void>;
    refreshButtonState: (conversationId?: string) => void;
    scheduleButtonRefresh: (conversationId: string) => void;
    maybeRunAutoCapture: (conversationId: string, reason: AutoCaptureReason) => void;
};

/**
 * Applies debounce and generation-guard filtering to a response-finished signal.
 * Returns `true` when the signal should be processed.
 */
export const shouldProcessFinishedSignal = (
    conversationId: string | null,
    source: 'network' | 'dom',
    attemptId: string | null,
    deps: ResponseFinishedDeps,
): boolean => {
    if (!conversationId) {
        logger.info('Finished signal ignored: missing conversation context', { source });
        return false;
    }
    if (
        source === 'network' &&
        deps.adapterName() === 'ChatGPT' &&
        deps.shouldBlockActionsForGeneration(conversationId)
    ) {
        logger.info('Finished signal blocked by generation guard', { conversationId, source });
        return false;
    }
    const now = Date.now();
    const last = deps.getLastResponseFinished();
    const isSameConversation = conversationId === last.conversationId;
    const { minIntervalMs, effectiveAttemptId } = resolveFinishedSignalDebounce(
        conversationId,
        source,
        attemptId,
        last.conversationId,
        last.attemptId,
    );
    if (isSameConversation && now - last.at < minIntervalMs) {
        logger.info('Finished signal debounced', {
            conversationId,
            source,
            attemptId: effectiveAttemptId || null,
            elapsed: now - last.at,
            minIntervalMs,
        });
        return false;
    }
    deps.setLastResponseFinished(now, conversationId, effectiveAttemptId || last.attemptId);
    return true;
};

/**
 * Post-completion orchestration: lifecycle promotion, stream-done probe,
 * button refresh, and auto-capture scheduling.
 */
export const processFinishedConversation = (
    conversationId: string,
    attemptId: string,
    source: 'network' | 'dom',
    deps: ResponseFinishedDeps,
) => {
    const cached = deps.getConversation(conversationId);
    const cachedReady = !!cached && deps.evaluateReadiness(cached).ready;

    if (shouldPromoteGrokFromCanonicalCapture(source, cachedReady, deps.getLifecycleState(), deps.adapterName())) {
        deps.setCompletedLifecycleState(conversationId, attemptId);
    }

    const shouldPromoteGenericCompleted =
        deps.getLifecycleState() !== 'completed' && source === 'dom' && deps.adapterName() === 'ChatGPT';
    if (shouldPromoteGenericCompleted) {
        deps.setCompletedLifecycleState(conversationId, attemptId);
    }

    if (!cached || !cachedReady) {
        if (!shouldPromoteGenericCompleted) {
            deps.setCompletedLifecycleState(conversationId, attemptId);
        }
        void deps.runStreamDoneProbe(conversationId, attemptId);
    }

    deps.refreshButtonState(conversationId);
    deps.scheduleButtonRefresh(conversationId);
    deps.maybeRunAutoCapture(conversationId, 'response-finished');
};

/**
 * Top-level handler for response-finished signals. Resolves the conversation
 * and attempt IDs, applies debounce, ingests SFE state, and delegates to
 * `processFinishedConversation`.
 */
export const processResponseFinished = (
    source: 'network' | 'dom',
    hintedConversationId: string | undefined,
    deps: ResponseFinishedDeps,
) => {
    const conversationId =
        hintedConversationId ?? deps.extractConversationIdFromUrl() ?? deps.getCurrentConversationId();
    const peekedAttemptId = conversationId ? deps.peekAttemptId(conversationId) : null;
    if (!shouldProcessFinishedSignal(conversationId, source, peekedAttemptId, deps)) {
        return;
    }
    const attemptId = peekedAttemptId ?? deps.resolveAttemptId(conversationId ?? undefined);
    if (!peekedAttemptId) {
        const last = deps.getLastResponseFinished();
        deps.setLastResponseFinished(last.at, last.conversationId, attemptId);
    }
    deps.setActiveAttempt(attemptId);
    deps.ingestSfeLifecycle('completed_hint', attemptId, conversationId);
    if (conversationId) {
        deps.setCurrentConversation(conversationId);
        deps.bindAttempt(conversationId, attemptId);
    }
    logger.info('Response finished signal', {
        source,
        attemptId,
        conversationId,
        calibrationState: deps.getCalibrationState(),
    });
    if (deps.getCalibrationState() === 'waiting') {
        return;
    }
    if (conversationId) {
        processFinishedConversation(conversationId, attemptId, source, deps);
    }
};
