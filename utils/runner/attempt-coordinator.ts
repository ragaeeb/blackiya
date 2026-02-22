import { setBoundedMapValue } from '@/utils/bounded-collections';
import type { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import type { ResponseLifecycleMessage } from '@/utils/protocol/messages';
import {
    bindAttempt as bindAttemptCore,
    cachePendingLifecycleSignal as cachePendingLifecycleSignalCore,
    forwardAttemptAlias as forwardAttemptAliasCore,
    type PendingLifecycleCacheDeps,
    peekAttemptId as peekAttemptIdCore,
    resolveAliasedAttemptId as resolveAliasedAttemptIdCore,
    resolveAttemptId as resolveAttemptIdCore,
} from '@/utils/runner/attempt-state';
import type { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';
import type { ExportMeta } from '@/utils/sfe/types';

export type AttemptCoordinatorDeps = {
    maxConversationAttempts: number;
    maxPendingLifecycleAttempts: number;

    attemptByConversation: Map<string, string>;
    attemptAliasForward: Map<string, string>;
    pendingLifecycleByAttempt: Map<
        string,
        { phase: ResponseLifecycleMessage['phase']; platform: string; receivedAtMs: number }
    >;
    captureMetaByConversation: Map<string, ExportMeta>;

    getCurrentConversationId: () => string | null;
    setCurrentConversationId: (conversationId: string | null) => void;
    getActiveAttemptId: () => string | null;
    setActiveAttemptId: (attemptId: string | null) => void;
    setRunnerConversationId: (conversationId: string | null) => void;
    setRunnerActiveAttemptId: (attemptId: string | null) => void;

    getAdapterName: () => string | undefined;
    sfe: SignalFusionEngine;
    cancelStreamDoneProbe: (attemptId: string, reason: 'superseded') => void;
    clearCanonicalStabilizationRetry: (attemptId: string) => void;
    clearProbeLeaseRetry: (attemptId: string) => void;
    emitAttemptDisposed: (attemptId: string, reason: 'superseded') => void;
    migratePendingStreamProbeText: (conversationId: string, canonicalAttemptId: string) => void;
    structuredLogger: StructuredAttemptLogger;
    emitWarn: (message: string, data?: unknown) => void;
    lastPendingLifecycleCapacityWarnAtRef: { value: number };
};

export const createAttemptCoordinator = (deps: AttemptCoordinatorDeps) => {
    const setCurrentConversation = (conversationId: string | null) => {
        deps.setCurrentConversationId(conversationId);
        deps.setRunnerConversationId(conversationId);
    };

    const setActiveAttempt = (attemptId: string | null) => {
        deps.setActiveAttemptId(attemptId);
        deps.setRunnerActiveAttemptId(attemptId);
    };

    const buildPendingLifecycleCacheDeps = (): PendingLifecycleCacheDeps => ({
        pendingLifecycleByAttempt: deps.pendingLifecycleByAttempt,
        maxPendingLifecycleAttempts: deps.maxPendingLifecycleAttempts,
        lastPendingLifecycleCapacityWarnAtRef: deps.lastPendingLifecycleCapacityWarnAtRef,
        emitWarn: deps.emitWarn,
    });

    const cachePendingLifecycleSignal = (
        attemptId: string,
        phase: ResponseLifecycleMessage['phase'],
        platform: string,
    ) => cachePendingLifecycleSignalCore(attemptId, phase, platform, buildPendingLifecycleCacheDeps());

    const setCaptureMetaForConversation = (conversationId: string, meta: ExportMeta) =>
        setBoundedMapValue(deps.captureMetaByConversation, conversationId, meta, deps.maxConversationAttempts);

    const markSnapshotCaptureMeta = (conversationId: string) =>
        setCaptureMetaForConversation(conversationId, {
            captureSource: 'dom_snapshot_degraded',
            fidelity: 'degraded',
            completeness: 'partial',
        });

    const markCanonicalCaptureMeta = (conversationId: string) =>
        setCaptureMetaForConversation(conversationId, {
            captureSource: 'canonical_api',
            fidelity: 'high',
            completeness: 'complete',
        });

    const resolveAliasedAttemptId = (attemptId: string) =>
        resolveAliasedAttemptIdCore(attemptId, deps.attemptAliasForward);

    const forwardAttemptAlias = (fromAttemptId: string, toAttemptId: string, reason: 'superseded' | 'rebound') =>
        forwardAttemptAliasCore(fromAttemptId, toAttemptId, reason, {
            attemptAliasForward: deps.attemptAliasForward,
            maxAliasEntries: deps.maxConversationAttempts * 2,
            structuredLogger: deps.structuredLogger,
        });

    const peekAttemptId = (conversationId?: string): string | null =>
        peekAttemptIdCore({
            conversationId,
            activeAttemptId: deps.getActiveAttemptId(),
            attemptByConversation: deps.attemptByConversation,
            resolveAliasedAttemptId,
        });

    const resolveAttemptId = (conversationId?: string): string =>
        resolveAttemptIdCore({
            conversationId,
            activeAttemptId: deps.getActiveAttemptId(),
            adapterName: deps.getAdapterName(),
            attemptByConversation: deps.attemptByConversation,
            resolveAliasedAttemptId,
            setActiveAttempt,
        });

    const bindAttempt = (conversationId: string | undefined, attemptId: string) => {
        bindAttemptCore({
            conversationId,
            attemptId,
            attemptByConversation: deps.attemptByConversation,
            resolveAliasedAttemptId,
            maxConversationAttempts: deps.maxConversationAttempts,
            markAttemptSuperseded: (previousAttemptId, nextAttemptId) => {
                deps.sfe.getAttemptTracker().markSuperseded(previousAttemptId, nextAttemptId);
            },
            cancelStreamDoneProbe: (id, reason) => {
                deps.cancelStreamDoneProbe(id, reason);
            },
            clearCanonicalStabilizationRetry: deps.clearCanonicalStabilizationRetry,
            clearProbeLeaseRetry: deps.clearProbeLeaseRetry,
            emitAttemptDisposed: (id, reason) => {
                deps.emitAttemptDisposed(id, reason);
            },
            forwardAttemptAlias: (fromAttemptId, toAttemptId, reason) => {
                forwardAttemptAlias(fromAttemptId, toAttemptId, reason);
            },
            structuredLogger: deps.structuredLogger,
            migratePendingStreamProbeText: deps.migratePendingStreamProbeText,
        });
    };

    const isAttemptDisposedOrSuperseded = (attemptId: string): boolean => {
        const phase = deps.sfe.resolve(attemptId).phase;
        return phase === 'disposed' || phase === 'superseded';
    };

    return {
        setCurrentConversation,
        setActiveAttempt,
        cachePendingLifecycleSignal,
        markSnapshotCaptureMeta,
        markCanonicalCaptureMeta,
        resolveAliasedAttemptId,
        forwardAttemptAlias,
        peekAttemptId,
        resolveAttemptId,
        bindAttempt,
        isAttemptDisposedOrSuperseded,
    };
};
