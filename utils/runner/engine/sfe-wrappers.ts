import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import type { AttemptDisposedMessage, ResponseLifecycleMessage } from '@/utils/protocol/messages';
import { stampToken } from '@/utils/protocol/session-token';
import { evaluateReadinessForData } from '@/utils/runner/engine/core-utils';
import type { EngineCtx } from '@/utils/runner/engine/types';
import type { SfeIngestionDeps } from '@/utils/runner/sfe-ingestion';
import {
    emitAttemptDisposed as emitAttemptDisposedCore,
    ingestSfeCanonicalSample as ingestSfeCanonicalSampleCore,
    ingestSfeLifecycleFromWirePhase as ingestSfeLifecycleFromWirePhaseCore,
    ingestSfeLifecycleSignal as ingestSfeLifecycleSignalCore,
    logSfeMismatchIfNeeded as logSfeMismatchIfNeededCore,
} from '@/utils/runner/sfe-ingestion';
import type { StaleAttemptFilterDeps } from '@/utils/runner/stale-attempt-filter';
import { isStaleAttemptMessage as isStaleAttemptMessageCore } from '@/utils/runner/stale-attempt-filter';
import type { LifecyclePhase } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

const buildSfeIngestionDeps = (ctx: EngineCtx): SfeIngestionDeps => ({
    sfeEnabled: ctx.sfeEnabled,
    sfe: ctx.sfe,
    platformName: ctx.currentAdapter?.name ?? 'Unknown',
    resolveAttemptId: (cid) => ctx.resolveAttemptId(cid),
    bindAttempt: (cid, aid) => ctx.bindAttempt(cid, aid),
    evaluateReadiness: (data) => evaluateReadinessForData(ctx, data),
    getLifecycleState: () => ctx.lifecycleState,
    scheduleCanonicalStabilizationRetry: (cid, aid) => ctx.scheduleCanonicalStabilizationRetry(cid, aid),
    clearCanonicalStabilizationRetry: (aid) => ctx.clearCanonicalStabilizationRetry(aid),
    syncStreamProbePanelFromCanonical: (cid, data) => ctx.syncStreamProbePanelFromCanonical(cid, data),
    refreshButtonState: (cid) => ctx.refreshButtonState(cid),
    structuredLogger: ctx.structuredLogger,
});

export const ingestSfeLifecycle = (
    ctx: EngineCtx,
    phase: LifecyclePhase,
    attemptId: string,
    conversationId?: string | null,
) => ingestSfeLifecycleSignalCore(phase, attemptId, conversationId, buildSfeIngestionDeps(ctx));

export const ingestSfeCanonicalSample = (ctx: EngineCtx, data: ConversationData, attemptId?: string) =>
    ingestSfeCanonicalSampleCore(data, attemptId, buildSfeIngestionDeps(ctx));

export const logSfeMismatchIfNeeded = (ctx: EngineCtx, conversationId: string, legacyReady: boolean) =>
    logSfeMismatchIfNeededCore(conversationId, legacyReady, {
        sfeEnabled: ctx.sfeEnabled,
        sfe: ctx.sfe,
        structuredLogger: ctx.structuredLogger,
        peekAttemptId: (cid) => ctx.peekAttemptId(cid),
    });

export const emitAttemptDisposed = (ctx: EngineCtx, attemptId: string, reason: AttemptDisposedMessage['reason']) =>
    emitAttemptDisposedCore(attemptId, reason, {
        pendingLifecycleByAttempt: ctx.pendingLifecycleByAttempt,
        structuredLogger: ctx.structuredLogger,
        postDisposedMessage: (aid, r) => {
            const payload: AttemptDisposedMessage = {
                type: MESSAGE_TYPES.ATTEMPT_DISPOSED,
                attemptId: aid,
                reason: r as AttemptDisposedMessage['reason'],
            };
            window.postMessage(stampToken(payload), window.location.origin);
        },
    });

export const ingestSfeLifecycleFromWirePhase = (
    ctx: EngineCtx,
    phase: ResponseLifecycleMessage['phase'],
    attemptId: string,
    conversationId?: string | null,
) => ingestSfeLifecycleFromWirePhaseCore(phase, attemptId, conversationId, buildSfeIngestionDeps(ctx));

export const isStaleAttemptMessage = (
    ctx: EngineCtx,
    attemptId: string,
    conversationId: string | undefined,
    signalType: 'lifecycle' | 'finished' | 'delta' | 'conversation-resolved',
): boolean => {
    const deps: StaleAttemptFilterDeps = {
        resolveAliasedAttemptId: (aid) => ctx.resolveAliasedAttemptId(aid),
        isAttemptDisposedOrSuperseded: (aid) => ctx.isAttemptDisposedOrSuperseded(aid),
        attemptByConversation: ctx.attemptByConversation,
        structuredLogger: ctx.structuredLogger,
    };
    return isStaleAttemptMessageCore(attemptId, conversationId, signalType, deps);
};
