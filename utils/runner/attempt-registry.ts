import { createAttemptId } from '@/utils/protocol/messages';

export const shouldRemoveDisposedAttemptBinding = (
    mappedAttemptId: string,
    disposedAttemptId: string,
    resolveAttemptId: (attemptId: string) => string,
) => {
    return resolveAttemptId(mappedAttemptId) === resolveAttemptId(disposedAttemptId);
};

export type ResolveRunnerAttemptIdInput = {
    conversationId?: string;
    activeAttemptId: string | null;
    adapterName?: string;
    attemptByConversation: Map<string, string>;
    resolveAliasedAttemptId: (attemptId: string) => string;
};

export type ResolveRunnerAttemptIdResult = {
    attemptId: string;
    nextActiveAttemptId: string | null;
};

/**
 * Pure read-only lookup: returns the existing attempt ID for a conversation
 * or the current active attempt. Returns `null` if no attempt exists.
 * Never creates a new attempt or signals mutation of activeAttemptId.
 *
 * Use this for logging, display, throttle-key lookups, and any other
 * read-path that should NOT mutate runner state.
 */
export const peekRunnerAttemptId = (input: {
    conversationId?: string;
    activeAttemptId: string | null;
    attemptByConversation: Map<string, string>;
    resolveAliasedAttemptId: (attemptId: string) => string;
}): string | null => {
    const { conversationId, attemptByConversation, resolveAliasedAttemptId } = input;
    if (conversationId) {
        const mapped = attemptByConversation.get(conversationId);
        if (mapped) {
            return resolveAliasedAttemptId(mapped);
        }
    }
    if (input.activeAttemptId) {
        return resolveAliasedAttemptId(input.activeAttemptId);
    }
    return null;
};

/**
 * Mutating resolve: returns the existing attempt ID or creates a new one.
 * The caller MUST apply the `nextActiveAttemptId` side effect.
 *
 * Use this only for write paths that intentionally create or bind attempts
 * (e.g., response-finished, stream-done probe setup, force-save recovery).
 */
export const resolveRunnerAttemptId = (input: ResolveRunnerAttemptIdInput): ResolveRunnerAttemptIdResult => {
    const { conversationId, attemptByConversation, resolveAliasedAttemptId } = input;
    if (conversationId) {
        const mapped = attemptByConversation.get(conversationId);
        if (mapped) {
            return {
                attemptId: resolveAliasedAttemptId(mapped),
                nextActiveAttemptId: input.activeAttemptId,
            };
        }
    }
    if (input.activeAttemptId) {
        return {
            attemptId: resolveAliasedAttemptId(input.activeAttemptId),
            nextActiveAttemptId: input.activeAttemptId,
        };
    }
    const prefix = (input.adapterName ?? 'attempt').toLowerCase().replace(/\s+/g, '-');
    const created = createAttemptId(prefix);
    return {
        attemptId: created,
        nextActiveAttemptId: created,
    };
};

export const getConversationAttemptMismatch = (
    canonicalAttemptId: string,
    conversationId: string | undefined,
    attemptByConversation: Map<string, string>,
    resolveAliasedAttemptId: (attemptId: string) => string,
): string | null => {
    if (!conversationId) {
        return null;
    }
    const mapped = attemptByConversation.get(conversationId);
    const canonicalMapped = mapped ? resolveAliasedAttemptId(mapped) : null;
    if (!canonicalMapped || canonicalMapped === canonicalAttemptId) {
        return null;
    }
    return canonicalMapped;
};
