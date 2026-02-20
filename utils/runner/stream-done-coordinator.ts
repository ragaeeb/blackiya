import type { LLMPlatform } from '@/platforms/types';
import { logger } from '@/utils/logger';
import type { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import {
    runStreamDoneProbe as runStreamDoneProbeCore,
    type StreamDoneProbeDeps,
} from '@/utils/runner/stream-done-probe';
import type { CrossTabProbeLease } from '@/utils/sfe/cross-tab-probe-lease';
import type { PlatformReadiness } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

type ProbeCancelReason = 'superseded' | 'disposed' | 'navigation' | 'teardown';

export type StreamDoneCoordinatorDeps = {
    probeLease: CrossTabProbeLease;
    probeLeaseTtlMs: number;
    probeLeaseRetryGraceMs: number;
    streamProbeControllers: Map<string, AbortController>;
    probeLeaseRetryTimers: Map<string, number>;
    attemptByConversation: Map<string, string>;
    resolveAliasedAttemptId: (attemptId: string) => string;
    isAttemptDisposedOrSuperseded: (attemptId: string) => boolean;
    structuredLogger: StructuredAttemptLogger;
    setStreamProbePanel: (status: string, body: string) => void;
    withPreservedLiveMirrorSnapshot: (conversationId: string, status: string, primaryBody: string) => string;
    resolveAttemptId: (conversationId?: string) => string;
    getCurrentAdapter: () => LLMPlatform | null;
    getFetchUrlCandidates: (conversationId: string) => string[];
    getRawSnapshotReplayUrls: (conversationId: string, snapshot: { url: string }) => string[];
    getConversation: (conversationId: string) => ConversationData | null;
    evaluateReadiness: (data: ConversationData) => PlatformReadiness;
    ingestConversationData: (data: ConversationData, source: string) => void;
    ingestInterceptedData: (args: { url: string; data: string; platform: string }) => void;
    requestSnapshot: (conversationId: string) => Promise<unknown | null>;
    buildIsolatedSnapshot: (conversationId: string) => ConversationData | null;
    extractResponseText: (data: ConversationData) => string;
    setLastProbeKey: (key: string, conversationId: string) => void;
    isProbeKeyActive: (key: string) => boolean;
};

export const createStreamDoneCoordinator = (deps: StreamDoneCoordinatorDeps) => {
    function cancelStreamDoneProbe(attemptId: string, reason: ProbeCancelReason) {
        const controller = deps.streamProbeControllers.get(attemptId);
        if (!controller) {
            return;
        }
        deps.streamProbeControllers.delete(attemptId);
        controller.abort();
        deps.structuredLogger.emit(
            attemptId,
            'debug',
            'probe_cancelled',
            'Stream done probe canceled',
            { reason },
            `probe-cancel:${reason}`,
        );
    }

    function clearProbeLeaseRetry(attemptId: string) {
        const timerId = deps.probeLeaseRetryTimers.get(attemptId);
        if (timerId !== undefined) {
            clearTimeout(timerId);
            deps.probeLeaseRetryTimers.delete(attemptId);
        }
    }

    const tryAcquireProbeLease = async (conversationId: string, attemptId: string): Promise<boolean> => {
        const claim = await deps.probeLease.claim(conversationId, attemptId, deps.probeLeaseTtlMs);
        if (claim.acquired) {
            clearProbeLeaseRetry(attemptId);
            return true;
        }
        deps.structuredLogger.emit(
            attemptId,
            'debug',
            'probe_lease_blocked',
            'Probe lease held by another tab',
            { conversationId, ownerAttemptId: claim.ownerAttemptId, expiresAtMs: claim.expiresAtMs },
            `probe-lease-blocked:${conversationId}:${claim.ownerAttemptId ?? 'unknown'}`,
        );
        if (!deps.probeLeaseRetryTimers.has(attemptId) && !deps.isAttemptDisposedOrSuperseded(attemptId)) {
            const now = Date.now();
            const expiresAtMs = claim.expiresAtMs ?? now + deps.probeLeaseRetryGraceMs;
            const delayMs = Math.max(expiresAtMs - now + deps.probeLeaseRetryGraceMs, deps.probeLeaseRetryGraceMs);
            const timerId = window.setTimeout(() => {
                deps.probeLeaseRetryTimers.delete(attemptId);
                if (deps.isAttemptDisposedOrSuperseded(attemptId)) {
                    return;
                }
                const mappedAttempt = deps.attemptByConversation.get(conversationId);
                if (mappedAttempt && deps.resolveAliasedAttemptId(mappedAttempt) !== attemptId) {
                    return;
                }
                void runStreamDoneProbe(conversationId, attemptId);
            }, delayMs);
            deps.probeLeaseRetryTimers.set(attemptId, timerId);
        }
        deps.setStreamProbePanel(
            'stream-done: lease held by another tab',
            deps.withPreservedLiveMirrorSnapshot(
                conversationId,
                'stream-done: lease held by another tab',
                `Another tab is probing canonical capture for ${conversationId}. Retrying shortly.`,
            ),
        );
        return false;
    };

    const buildStreamDoneProbeDeps = (): StreamDoneProbeDeps => ({
        platformName: deps.getCurrentAdapter()?.name ?? 'Unknown',
        parseInterceptedData: (text, url) => deps.getCurrentAdapter()?.parseInterceptedData(text, url) ?? null,
        isAttemptDisposedOrSuperseded: deps.isAttemptDisposedOrSuperseded,
        acquireProbeLease: tryAcquireProbeLease,
        releaseProbeLease: (conversationId, attemptId) => deps.probeLease.release(conversationId, attemptId),
        cancelExistingProbe: (attemptId) => cancelStreamDoneProbe(attemptId, 'superseded'),
        registerProbeController: (attemptId, controller) => deps.streamProbeControllers.set(attemptId, controller),
        unregisterProbeController: (attemptId) => deps.streamProbeControllers.delete(attemptId),
        resolveAttemptId: deps.resolveAttemptId,
        getFetchUrlCandidates: deps.getFetchUrlCandidates,
        getRawSnapshotReplayUrls: deps.getRawSnapshotReplayUrls,
        getConversation: deps.getConversation,
        evaluateReadiness: deps.evaluateReadiness,
        ingestConversationData: deps.ingestConversationData,
        ingestInterceptedData: deps.ingestInterceptedData,
        requestSnapshot: deps.requestSnapshot,
        buildIsolatedSnapshot: deps.buildIsolatedSnapshot,
        extractResponseText: deps.extractResponseText,
        setStreamDonePanel: (conversationId, status, body) =>
            deps.setStreamProbePanel(status, deps.withPreservedLiveMirrorSnapshot(conversationId, status, body)),
        onProbeActive: deps.setLastProbeKey,
        isProbeKeyActive: deps.isProbeKeyActive,
        emitLog: (level, message, payload) =>
            level === 'info' ? logger.info(message, payload) : logger.warn(message, payload),
    });

    const runStreamDoneProbe = (conversationId: string, hintedAttemptId?: string): Promise<void> => {
        if (!deps.getCurrentAdapter()) {
            return Promise.resolve();
        }
        return runStreamDoneProbeCore(conversationId, hintedAttemptId, buildStreamDoneProbeDeps());
    };

    return {
        cancelStreamDoneProbe,
        clearProbeLeaseRetry,
        runStreamDoneProbe,
    };
};
