/**
 * Lifecycle phase handler — applies lifecycle phase transitions
 * from wire messages to the runner's lifecycle state.
 *
 * Handles regression blocking (Completed → Streaming), SFE ingestion,
 * stream probe panel initialisation, and post-completion canonical
 * stabilization scheduling.
 */

import { logger } from '@/utils/logger';
import type { ResponseLifecycleMessage } from '@/utils/protocol/messages';
import type { RunnerStreamPreviewState } from '@/utils/runner/stream-preview';
import { ensureLiveRunnerStreamPreview } from '@/utils/runner/stream-preview';
import type { ExportMeta } from '@/utils/sfe/types';

export type LifecyclePhaseHandlerDeps = {
    getLifecycleState: () => string;
    getLifecycleConversationId: () => string | null;
    getLifecycleAttemptId: () => string | null;
    setLifecycleAttemptId: (id: string) => void;
    setLifecycleConversationId: (id: string) => void;
    setLifecycleState: (state: 'prompt-sent' | 'streaming' | 'completed', conversationId?: string) => void;
    streamPreviewState: RunnerStreamPreviewState;
    liveStreamPreviewByConversation: Map<string, string>;
    setStreamProbePanel: (status: string, body: string) => void;
    ingestSfeLifecycleFromWirePhase: (
        phase: ResponseLifecycleMessage['phase'],
        attemptId: string,
        conversationId?: string | null,
    ) => void;
    sfeEnabled: () => boolean;
    sfeResolve: (attemptId: string) => { ready: boolean; phase: string; blockingConditions: string[] };
    getCaptureMeta: (conversationId: string) => ExportMeta;
    shouldIngestAsCanonicalSample: (meta: ExportMeta) => boolean;
    scheduleCanonicalStabilizationRetry: (conversationId: string, attemptId: string) => void;
    runStreamDoneProbe: (conversationId: string, attemptId: string) => void;
};

export const applyActiveLifecyclePhase = (
    phase: 'prompt-sent' | 'streaming',
    attemptId: string,
    conversationId: string,
    source: 'direct' | 'replayed',
    deps: LifecyclePhaseHandlerDeps,
) => {
    if (
        deps.getLifecycleState() === 'completed' &&
        deps.getLifecycleConversationId() === conversationId &&
        deps.getLifecycleAttemptId() === attemptId
    ) {
        logger.info('Lifecycle regression blocked', {
            from: deps.getLifecycleState(),
            to: phase,
            attemptId,
            conversationId,
            source,
        });
        return;
    }
    if (!deps.liveStreamPreviewByConversation.has(conversationId)) {
        ensureLiveRunnerStreamPreview(deps.streamPreviewState, conversationId);
        deps.setStreamProbePanel('stream: awaiting delta', `conversationId=${conversationId}`);
    }
    deps.setLifecycleAttemptId(attemptId);
    deps.setLifecycleConversationId(conversationId);
    deps.setLifecycleState(phase, conversationId);
};

export const applyLifecyclePhaseForConversation = (
    phase: ResponseLifecycleMessage['phase'],
    platform: string,
    attemptId: string,
    conversationId: string,
    source: 'direct' | 'replayed',
    deps: LifecyclePhaseHandlerDeps,
) => {
    logger.info('Lifecycle phase', { platform, phase, attemptId, conversationId, source });
    deps.ingestSfeLifecycleFromWirePhase(phase, attemptId, conversationId);
    if (phase === 'prompt-sent' || phase === 'streaming') {
        applyActiveLifecyclePhase(phase, attemptId, conversationId, source, deps);
        return;
    }
    if (phase === 'completed') {
        deps.setLifecycleAttemptId(attemptId);
        deps.setLifecycleConversationId(conversationId);
        deps.setLifecycleState('completed', conversationId);
        if (!deps.sfeEnabled()) {
            void deps.runStreamDoneProbe(conversationId, attemptId);
            return;
        }
        const resolution = deps.sfeResolve(attemptId);
        const captureMeta = deps.getCaptureMeta(conversationId);
        const shouldRetry =
            !resolution.blockingConditions.includes('stabilization_timeout') &&
            !resolution.ready &&
            (resolution.phase === 'canonical_probing' || !deps.shouldIngestAsCanonicalSample(captureMeta));
        if (shouldRetry) {
            deps.scheduleCanonicalStabilizationRetry(conversationId, attemptId);
        }
        void deps.runStreamDoneProbe(conversationId, attemptId);
    }
};
