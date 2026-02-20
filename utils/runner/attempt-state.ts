import { setBoundedMapValue } from '@/utils/bounded-collections';
import type { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import type { ResponseLifecycleMessage } from '@/utils/protocol/messages';
import {
    peekRunnerAttemptId,
    resolveRunnerAttemptId,
    shouldRemoveDisposedAttemptBinding,
} from '@/utils/runner/attempt-registry';
import { getLifecyclePhasePriority } from '@/utils/runner/lifecycle-manager';

export type PendingLifecycleEntry = {
    phase: ResponseLifecycleMessage['phase'];
    platform: string;
    receivedAtMs: number;
};

export type PendingLifecycleCacheDeps = {
    pendingLifecycleByAttempt: Map<string, PendingLifecycleEntry>;
    maxPendingLifecycleAttempts: number;
    warnIntervalMs?: number;
    lastPendingLifecycleCapacityWarnAtRef: { value: number };
    emitWarn: (message: string, data?: unknown) => void;
};

export const cachePendingLifecycleSignal = (
    attemptId: string,
    phase: ResponseLifecycleMessage['phase'],
    platform: string,
    deps: PendingLifecycleCacheDeps,
) => {
    const existing = deps.pendingLifecycleByAttempt.get(attemptId);
    if (existing && getLifecyclePhasePriority(existing.phase) > getLifecyclePhasePriority(phase)) {
        return;
    }
    setBoundedMapValue(
        deps.pendingLifecycleByAttempt,
        attemptId,
        { phase, platform, receivedAtMs: Date.now() },
        deps.maxPendingLifecycleAttempts,
    );
    if (deps.pendingLifecycleByAttempt.size < Math.floor(deps.maxPendingLifecycleAttempts * 0.9)) {
        return;
    }
    const now = Date.now();
    const warnIntervalMs = deps.warnIntervalMs ?? 15_000;
    if (now - deps.lastPendingLifecycleCapacityWarnAtRef.value <= warnIntervalMs) {
        return;
    }
    deps.lastPendingLifecycleCapacityWarnAtRef.value = now;
    deps.emitWarn('Pending lifecycle cache near capacity', {
        size: deps.pendingLifecycleByAttempt.size,
        maxEntries: deps.maxPendingLifecycleAttempts,
    });
};

export const resolveAliasedAttemptId = (attemptId: string, attemptAliasForward: Map<string, string>) => {
    let resolved = attemptId;
    const visited = new Set<string>();
    while (attemptAliasForward.has(resolved) && !visited.has(resolved)) {
        visited.add(resolved);
        const next = attemptAliasForward.get(resolved);
        if (!next) {
            break;
        }
        resolved = next;
    }
    return resolved;
};

export type ForwardAttemptAliasDeps = {
    attemptAliasForward: Map<string, string>;
    maxAliasEntries: number;
    structuredLogger: StructuredAttemptLogger;
};

export const forwardAttemptAlias = (
    fromAttemptId: string,
    toAttemptId: string,
    reason: 'superseded' | 'rebound',
    deps: ForwardAttemptAliasDeps,
) => {
    if (fromAttemptId === toAttemptId) {
        return;
    }
    setBoundedMapValue(deps.attemptAliasForward, fromAttemptId, toAttemptId, deps.maxAliasEntries);
    deps.structuredLogger.emit(
        toAttemptId,
        'info',
        'attempt_alias_forwarded',
        'Forwarded stale attempt alias to active attempt',
        { fromAttemptId, toAttemptId, reason },
        `attempt-alias:${fromAttemptId}:${toAttemptId}:${reason}`,
    );
};

export type PeekAttemptIdDeps = {
    conversationId?: string;
    activeAttemptId: string | null;
    attemptByConversation: Map<string, string>;
    resolveAliasedAttemptId: (attemptId: string) => string;
};

export const peekAttemptId = (deps: PeekAttemptIdDeps) =>
    peekRunnerAttemptId({
        conversationId: deps.conversationId,
        activeAttemptId: deps.activeAttemptId,
        attemptByConversation: deps.attemptByConversation,
        resolveAliasedAttemptId: deps.resolveAliasedAttemptId,
    });

export type ResolveAttemptIdDeps = {
    conversationId?: string;
    activeAttemptId: string | null;
    adapterName: string | undefined;
    attemptByConversation: Map<string, string>;
    resolveAliasedAttemptId: (attemptId: string) => string;
    setActiveAttempt: (attemptId: string | null) => void;
};

export const resolveAttemptId = (deps: ResolveAttemptIdDeps) => {
    const resolved = resolveRunnerAttemptId({
        conversationId: deps.conversationId,
        activeAttemptId: deps.activeAttemptId,
        adapterName: deps.adapterName,
        attemptByConversation: deps.attemptByConversation,
        resolveAliasedAttemptId: deps.resolveAliasedAttemptId,
    });
    deps.setActiveAttempt(resolved.nextActiveAttemptId);
    return resolved.attemptId;
};

export type BindAttemptDeps = {
    conversationId: string | undefined;
    attemptId: string;
    attemptByConversation: Map<string, string>;
    resolveAliasedAttemptId: (attemptId: string) => string;
    maxConversationAttempts: number;
    markAttemptSuperseded: (previousAttemptId: string, nextAttemptId: string) => void;
    cancelStreamDoneProbe: (attemptId: string, reason: 'superseded') => void;
    clearCanonicalStabilizationRetry: (attemptId: string) => void;
    clearProbeLeaseRetry: (attemptId: string) => void;
    emitAttemptDisposed: (attemptId: string, reason: 'superseded') => void;
    forwardAttemptAlias: (fromAttemptId: string, toAttemptId: string, reason: 'superseded') => void;
    structuredLogger: StructuredAttemptLogger;
    migratePendingStreamProbeText: (conversationId: string, canonicalAttemptId: string) => void;
};

export const bindAttempt = (deps: BindAttemptDeps) => {
    if (!deps.conversationId) {
        return;
    }
    const canonicalAttemptId = deps.resolveAliasedAttemptId(deps.attemptId);
    const isNewBinding = !deps.attemptByConversation.has(deps.conversationId);
    const previous = deps.attemptByConversation.get(deps.conversationId);
    if (previous && previous !== canonicalAttemptId) {
        const canonicalPrevious = deps.resolveAliasedAttemptId(previous);
        deps.markAttemptSuperseded(canonicalPrevious, deps.attemptId);
        deps.cancelStreamDoneProbe(canonicalPrevious, 'superseded');
        deps.clearCanonicalStabilizationRetry(canonicalPrevious);
        deps.clearProbeLeaseRetry(canonicalPrevious);
        deps.emitAttemptDisposed(canonicalPrevious, 'superseded');
        deps.forwardAttemptAlias(previous, deps.attemptId, 'superseded');
        deps.structuredLogger.emit(
            canonicalPrevious,
            'info',
            'attempt_superseded',
            'Attempt superseded by newer prompt',
            { conversationId: deps.conversationId, supersededBy: deps.attemptId },
            `supersede:${deps.conversationId}:${deps.attemptId}`,
        );
    }
    setBoundedMapValue(
        deps.attemptByConversation,
        deps.conversationId,
        canonicalAttemptId,
        deps.maxConversationAttempts,
    );
    deps.migratePendingStreamProbeText(deps.conversationId, canonicalAttemptId);
    if (isNewBinding || previous !== canonicalAttemptId) {
        deps.structuredLogger.emit(
            deps.attemptId,
            'debug',
            'attempt_created',
            'Attempt binding created',
            { conversationId: deps.conversationId },
            `attempt-created:${deps.conversationId}:${deps.attemptId}`,
        );
    }
};

export { shouldRemoveDisposedAttemptBinding };
