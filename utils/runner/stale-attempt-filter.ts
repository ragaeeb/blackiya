/**
 * Stale attempt message filter.
 *
 * Determines whether an incoming cross-world signal (lifecycle, finished,
 * delta, conversation-resolved) should be dropped because it targets a
 * disposed, superseded, or mismatched attempt. Emits structured diagnostics
 * for every drop reason.
 */

import type { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import { getConversationAttemptMismatch as getConversationAttemptMismatchForRegistry } from '@/utils/runner/attempt-registry';

export type SignalType = 'lifecycle' | 'finished' | 'delta' | 'conversation-resolved';

export type StaleAttemptFilterDeps = {
    resolveAliasedAttemptId: (attemptId: string) => string;
    isAttemptDisposedOrSuperseded: (attemptId: string) => boolean;
    attemptByConversation: Map<string, string>;
    structuredLogger: StructuredAttemptLogger;
};

const emitAliasResolutionLog = (
    canonicalAttemptId: string,
    signalType: SignalType,
    originalAttemptId: string,
    conversationId: string | undefined,
    deps: StaleAttemptFilterDeps,
) => {
    deps.structuredLogger.emit(
        canonicalAttemptId,
        'debug',
        'attempt_alias_forwarded',
        'Resolved stale attempt alias before processing signal',
        { signalType, originalAttemptId, canonicalAttemptId, conversationId: conversationId ?? null },
        `attempt-alias-resolve:${signalType}:${originalAttemptId}:${canonicalAttemptId}`,
    );
};

const emitLateSignalDrop = (
    canonicalAttemptId: string,
    signalType: SignalType,
    conversationId: string | undefined,
    deps: StaleAttemptFilterDeps,
) => {
    deps.structuredLogger.emit(
        canonicalAttemptId,
        'debug',
        'late_signal_dropped_after_dispose',
        'Dropped late signal for disposed or superseded attempt',
        { signalType, reason: 'disposed_or_superseded', conversationId: conversationId ?? null },
        `stale:${signalType}:${conversationId ?? 'unknown'}:disposed`,
    );
};

const emitConversationMismatchDrop = (
    canonicalAttemptId: string,
    signalType: SignalType,
    conversationId: string,
    activeAttemptIdParam: string,
    deps: StaleAttemptFilterDeps,
) => {
    deps.structuredLogger.emit(
        canonicalAttemptId,
        'debug',
        'stale_signal_ignored',
        'Ignored stale attempt signal',
        { signalType, reason: 'conversation_mismatch', conversationId, activeAttemptId: activeAttemptIdParam },
        `stale:${signalType}:${conversationId}:${activeAttemptIdParam}`,
    );
};

export const isStaleAttemptMessage = (
    attemptId: string,
    conversationId: string | undefined,
    signalType: SignalType,
    deps: StaleAttemptFilterDeps,
): boolean => {
    const canonicalAttemptId = deps.resolveAliasedAttemptId(attemptId);
    if (canonicalAttemptId !== attemptId) {
        emitAliasResolutionLog(canonicalAttemptId, signalType, attemptId, conversationId, deps);
    }
    if (deps.isAttemptDisposedOrSuperseded(canonicalAttemptId)) {
        emitLateSignalDrop(canonicalAttemptId, signalType, conversationId, deps);
        return true;
    }
    const mismatchedAttemptId = getConversationAttemptMismatchForRegistry(
        canonicalAttemptId,
        conversationId,
        deps.attemptByConversation,
        deps.resolveAliasedAttemptId,
    );
    if (conversationId && mismatchedAttemptId) {
        emitConversationMismatchDrop(canonicalAttemptId, signalType, conversationId, mismatchedAttemptId, deps);
        return true;
    }
    return false;
};
