/**
 * Public status snapshot emitter.
 *
 * Builds and posts the `BLACKIYA_PUBLIC_STATUS` message consumed by the
 * public `window.__blackiya` API surface. Deduplicates emissions via a
 * signature check so downstream listeners only fire on actual state changes.
 */

import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import type { BlackiyaPublicLifecycleState, PublicStatusMessage } from '@/utils/protocol/messages';
import { stampToken } from '@/utils/protocol/session-token';
import type { ReadinessDecision } from '@/utils/sfe/types';

export type PublicStatusState = {
    sequence: number;
    lastSignature: string;
};

export type PublicStatusDeps = {
    getCurrentConversationId: () => string | null;
    resolveLocationConversationId: () => string | null;
    peekAttemptId: (conversationId: string) => string | null;
    getActiveAttemptId: () => string | null;
    getAdapterName: () => string | null;
    getLifecycleState: () => BlackiyaPublicLifecycleState;
    resolveReadinessDecision: (conversationId: string) => ReadinessDecision;
    shouldBlockActionsForGeneration: (conversationId: string) => boolean;
    hasAdapter: () => boolean;
};

export const emitPublicStatusSnapshot = (
    conversationIdOverride: string | null | undefined,
    state: PublicStatusState,
    deps: PublicStatusDeps,
) => {
    const conversationId =
        conversationIdOverride === undefined
            ? (deps.getCurrentConversationId() ?? deps.resolveLocationConversationId())
            : conversationIdOverride;
    const attemptId = conversationId ? deps.peekAttemptId(conversationId) : deps.getActiveAttemptId();
    const platform = deps.getAdapterName();
    const lifecycle = deps.getLifecycleState();
    let readiness: PublicStatusMessage['status']['readiness'] = 'unknown';
    let readinessReason: string | null = null;
    let canGet = false;

    if (conversationId && deps.hasAdapter()) {
        const decision = deps.resolveReadinessDecision(conversationId);
        readiness = decision.mode;
        readinessReason = decision.reason ?? null;
        canGet = decision.mode === 'canonical_ready' && !deps.shouldBlockActionsForGeneration(conversationId);
    }

    const signature = JSON.stringify({
        platform,
        conversationId,
        attemptId,
        lifecycle,
        readiness,
        readinessReason,
        canGet,
    });
    if (signature === state.lastSignature) {
        return;
    }
    state.lastSignature = signature;
    state.sequence += 1;

    const payload: PublicStatusMessage = {
        type: MESSAGE_TYPES.PUBLIC_STATUS,
        status: {
            platform,
            conversationId,
            attemptId: attemptId ?? null,
            lifecycle,
            readiness,
            readinessReason,
            canGetJSON: canGet,
            canGetCommonJSON: canGet,
            sequence: state.sequence,
            timestampMs: Date.now(),
        },
    };
    window.postMessage(stampToken(payload), window.location.origin);
};
