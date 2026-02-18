import { addBoundedSetValue } from '@/utils/bounded-collections';

const DEFAULT_MAX_INTERCEPTOR_DISPOSED_ATTEMPTS = 500;

export function pruneTimestampCache(map: Map<string, number>, ttlMs: number, nowMs = Date.now()): number {
    let removed = 0;
    for (const [key, timestamp] of map.entries()) {
        if (nowMs - timestamp <= ttlMs) {
            continue;
        }
        map.delete(key);
        removed += 1;
    }
    return removed;
}

export function cleanupDisposedAttemptState(
    attemptIdToRemove: string,
    state: {
        disposedAttemptIds: Set<string>;
        streamDumpFrameCountByAttempt: Map<string, number>;
        streamDumpLastTextByAttempt: Map<string, string>;
        latestAttemptIdByPlatform: Map<string, string>;
        attemptByConversationId: Map<string, string>;
    },
    maxDisposedAttempts = DEFAULT_MAX_INTERCEPTOR_DISPOSED_ATTEMPTS,
): void {
    addBoundedSetValue(state.disposedAttemptIds, attemptIdToRemove, maxDisposedAttempts);
    state.streamDumpFrameCountByAttempt.delete(attemptIdToRemove);
    state.streamDumpLastTextByAttempt.delete(attemptIdToRemove);
    for (const [platform, attemptId] of state.latestAttemptIdByPlatform.entries()) {
        if (attemptId === attemptIdToRemove) {
            state.latestAttemptIdByPlatform.delete(platform);
        }
    }
    for (const [conversationId, attemptId] of state.attemptByConversationId.entries()) {
        if (attemptId === attemptIdToRemove) {
            state.attemptByConversationId.delete(conversationId);
        }
    }
}
