import { createAttemptId } from '@/utils/protocol/messages';

export function shouldRemoveDisposedAttemptBinding(
    mappedAttemptId: string,
    disposedAttemptId: string,
    resolveAttemptId: (attemptId: string) => string,
): boolean {
    return resolveAttemptId(mappedAttemptId) === resolveAttemptId(disposedAttemptId);
}

export interface ResolveRunnerAttemptIdInput {
    conversationId?: string;
    activeAttemptId: string | null;
    adapterName?: string;
    attemptByConversation: Map<string, string>;
    resolveAliasedAttemptId: (attemptId: string) => string;
}

export interface ResolveRunnerAttemptIdResult {
    attemptId: string;
    nextActiveAttemptId: string | null;
}

export function resolveRunnerAttemptId(input: ResolveRunnerAttemptIdInput): ResolveRunnerAttemptIdResult {
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
}

export function getConversationAttemptMismatch(
    canonicalAttemptId: string,
    conversationId: string | undefined,
    attemptByConversation: Map<string, string>,
    resolveAliasedAttemptId: (attemptId: string) => string,
): string | null {
    if (!conversationId) {
        return null;
    }
    const mapped = attemptByConversation.get(conversationId);
    const canonicalMapped = mapped ? resolveAliasedAttemptId(mapped) : null;
    if (!canonicalMapped || canonicalMapped === canonicalAttemptId) {
        return null;
    }
    return canonicalMapped;
}
