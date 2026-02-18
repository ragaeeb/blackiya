import type { PlatformReadiness } from '@/platforms/types';
import type { ExportMeta, ReadinessDecision } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

type LoggerDebug = (message: string, payload: Record<string, unknown>) => void;

type SfeConversationResolution = {
    ready?: boolean;
    reason?: string;
    blockingConditions: string[];
} | null;

export interface ResolveRunnerReadinessInput {
    conversationId: string;
    data: ConversationData | null;
    sfeEnabled: boolean;
    captureMeta: ExportMeta;
    sfeResolution: SfeConversationResolution;
    evaluateReadinessForData: (data: ConversationData) => PlatformReadiness;
    resolveAttemptId: (conversationId: string) => string;
    hasCanonicalStabilizationTimedOut: (attemptId: string) => boolean;
    emitTimeoutWarningOnce: (attemptId: string, conversationId: string) => void;
    clearTimeoutWarningByAttempt: (attemptId: string) => void;
    logSfeMismatchIfNeeded: (conversationId: string, legacyReady: boolean) => void;
    shouldLogCanonicalReadyDecision: (conversationId: string) => boolean;
    clearCanonicalReadyLogStamp: (conversationId: string) => void;
    loggerDebug?: LoggerDebug;
}

function createMissingDataReadinessDecision(): ReadinessDecision {
    return {
        ready: false,
        mode: 'awaiting_stabilization',
        reason: 'no_canonical_data',
    };
}

function createLegacyReadinessDecision(
    conversationId: string,
    readiness: PlatformReadiness,
    captureMeta: ExportMeta,
    loggerDebug?: LoggerDebug,
): ReadinessDecision {
    const ready = readiness.ready;
    if (ready) {
        loggerDebug?.('Readiness decision: SFE disabled, legacy ready', {
            conversationId,
            fidelity: captureMeta.fidelity,
            readinessReason: readiness.reason,
        });
    }
    return {
        ready,
        mode: ready ? 'canonical_ready' : 'awaiting_stabilization',
        reason: ready ? 'legacy_ready' : readiness.reason,
    };
}

function createTimeoutReadinessDecision(input: ResolveRunnerReadinessInput): ReadinessDecision | null {
    const attemptId = input.resolveAttemptId(input.conversationId);
    const hasTimeout =
        input.sfeResolution?.blockingConditions.includes('stabilization_timeout') === true ||
        (input.captureMeta.fidelity === 'degraded' && input.hasCanonicalStabilizationTimedOut(attemptId));
    if (!hasTimeout) {
        return null;
    }
    input.loggerDebug?.('Readiness decision: degraded_manual_only (timeout)', {
        conversationId: input.conversationId,
        attemptId,
        fidelity: input.captureMeta.fidelity,
    });
    input.emitTimeoutWarningOnce(attemptId, input.conversationId);
    return {
        ready: false,
        mode: 'degraded_manual_only',
        reason: 'stabilization_timeout',
    };
}

export function resolveRunnerReadinessDecision(input: ResolveRunnerReadinessInput): ReadinessDecision {
    if (!input.data) {
        input.clearCanonicalReadyLogStamp(input.conversationId);
        return createMissingDataReadinessDecision();
    }

    const readiness = input.evaluateReadinessForData(input.data);
    if (!input.sfeEnabled) {
        return createLegacyReadinessDecision(input.conversationId, readiness, input.captureMeta, input.loggerDebug);
    }

    const sfeReady = input.sfeResolution?.ready === true;
    input.logSfeMismatchIfNeeded(input.conversationId, readiness.ready);
    if (sfeReady && readiness.ready && input.captureMeta.fidelity === 'high') {
        if (input.shouldLogCanonicalReadyDecision(input.conversationId)) {
            input.loggerDebug?.('Readiness decision: canonical_ready', {
                conversationId: input.conversationId,
                fidelity: input.captureMeta.fidelity,
                sfeReady,
                legacyReady: readiness.ready,
            });
        }
        return {
            ready: true,
            mode: 'canonical_ready',
            reason: 'canonical_ready',
        };
    }

    input.clearCanonicalReadyLogStamp(input.conversationId);

    const timeoutDecision = createTimeoutReadinessDecision(input);
    if (timeoutDecision) {
        return timeoutDecision;
    }

    input.clearTimeoutWarningByAttempt(input.resolveAttemptId(input.conversationId));

    if (input.captureMeta.fidelity === 'degraded') {
        return {
            ready: false,
            mode: 'awaiting_stabilization',
            reason: 'snapshot_degraded_capture',
        };
    }

    return {
        ready: false,
        mode: 'awaiting_stabilization',
        reason: input.sfeResolution?.reason ?? readiness.reason,
    };
}
