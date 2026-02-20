/**
 * Interception capture processing — handles incoming conversation data
 * from the interception manager (network or snapshot sources).
 *
 * Applies stream-resolved titles, marks capture fidelity, ingests into SFE,
 * and triggers post-capture flows like response-finished handling.
 */

import { logger } from '@/utils/logger';
import type { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import type { PlatformReadiness } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

type InterceptionCaptureMeta = { attemptId?: string; source?: string };

export type InterceptionCaptureDeps = {
    getStreamResolvedTitle: (conversationId: string) => string | undefined;
    setCurrentConversation: (conversationId: string | null) => void;
    setActiveAttempt: (attemptId: string | null) => void;
    bindAttempt: (conversationId: string | undefined, attemptId: string) => void;
    peekAttemptId: (conversationId?: string) => string | null;
    resolveAttemptId: (conversationId?: string) => string;
    resolveAliasedAttemptId: (attemptId: string) => string;
    evaluateReadinessForData: (data: ConversationData) => PlatformReadiness;
    resolveReadinessDecision: (conversationId: string) => { mode: string };
    markSnapshotCaptureMeta: (conversationId: string) => void;
    markCanonicalCaptureMeta: (conversationId: string) => void;
    ingestSfeCanonicalSample: (data: ConversationData, attemptId?: string) => unknown;
    maybeRestartCanonicalRecoveryAfterTimeout: (conversationId: string, attemptId: string) => void;
    scheduleCanonicalStabilizationRetry: (conversationId: string, attemptId: string) => void;
    refreshButtonState: (conversationId?: string) => void;
    handleResponseFinished: (source: 'network' | 'dom', hintedConversationId?: string) => void;
    getLifecycleState: () => string;
    structuredLogger: StructuredAttemptLogger;
};

const applyStreamResolvedTitleIfNeeded = (
    conversationId: string,
    data: ConversationData,
    deps: InterceptionCaptureDeps,
) => {
    const streamTitle = deps.getStreamResolvedTitle(conversationId);
    if (streamTitle && data.title !== streamTitle) {
        data.title = streamTitle;
    }
};

const updateActiveAttemptFromMeta = (
    conversationId: string,
    meta: InterceptionCaptureMeta | undefined,
    deps: InterceptionCaptureDeps,
) => {
    if (!meta?.attemptId) {
        return;
    }
    deps.setActiveAttempt(meta.attemptId);
    deps.bindAttempt(conversationId, meta.attemptId);
};

const handleSnapshotSourceCapture = (
    conversationId: string,
    source: string,
    deps: InterceptionCaptureDeps,
) => {
    const existingDecision = deps.resolveReadinessDecision(conversationId);
    if (existingDecision.mode === 'canonical_ready') {
        deps.markCanonicalCaptureMeta(conversationId);
    } else {
        deps.markSnapshotCaptureMeta(conversationId);
    }
    const snapshotAttemptId = deps.peekAttemptId(conversationId) ?? deps.resolveAttemptId(conversationId);
    deps.structuredLogger.emit(
        snapshotAttemptId,
        'info',
        'snapshot_degraded_mode_used',
        'Snapshot-based capture marked as degraded/manual-only',
        { conversationId, source },
        `snapshot-degraded:${conversationId}:${source}`,
    );
    if (deps.getLifecycleState() === 'completed') {
        deps.scheduleCanonicalStabilizationRetry(conversationId, snapshotAttemptId);
    }
};

const handleNetworkSourceCapture = (
    conversationId: string,
    meta: InterceptionCaptureMeta | undefined,
    data: ConversationData | undefined,
    deps: InterceptionCaptureDeps,
) => {
    if (!data) {
        return;
    }
    const source = meta?.source ?? 'network';
    const effectiveAttemptId = deps.resolveAliasedAttemptId(
        meta?.attemptId ?? deps.resolveAttemptId(conversationId),
    );
    deps.maybeRestartCanonicalRecoveryAfterTimeout(conversationId, effectiveAttemptId);
    logger.info('Network source: marking canonical fidelity', {
        conversationId,
        source,
        effectiveAttemptId,
        readinessReady: deps.evaluateReadinessForData(data).ready,
    });
    deps.markCanonicalCaptureMeta(conversationId);
    deps.ingestSfeCanonicalSample(data, effectiveAttemptId);
};

export const processInterceptionCapture = (
    capturedId: string,
    data: ConversationData,
    meta: InterceptionCaptureMeta | undefined,
    deps: InterceptionCaptureDeps,
) => {
    applyStreamResolvedTitleIfNeeded(capturedId, data, deps);
    deps.setCurrentConversation(capturedId);
    updateActiveAttemptFromMeta(capturedId, meta, deps);

    const source = meta?.source ?? 'network';
    if (source.includes('snapshot') || source.includes('dom')) {
        handleSnapshotSourceCapture(capturedId, source, deps);
    } else {
        handleNetworkSourceCapture(capturedId, meta, data, deps);
    }

    deps.refreshButtonState(capturedId);
    if (deps.evaluateReadinessForData(data).ready) {
        deps.handleResponseFinished('network', capturedId);
    }
};
