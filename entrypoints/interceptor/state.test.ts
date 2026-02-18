import { describe, expect, it } from 'bun:test';
import { cleanupDisposedAttemptState, pruneTimestampCache } from '@/entrypoints/interceptor/state';

describe('interceptor state helpers', () => {
    it('prunes timestamp cache entries older than ttl', () => {
        const now = 10_000;
        const map = new Map<string, number>([
            ['fresh', now - 200],
            ['stale-a', now - 5000],
            ['stale-b', now - 6000],
        ]);
        const removed = pruneTimestampCache(map, 1_000, now);
        expect(removed).toBe(2);
        expect(map.has('fresh')).toBe(true);
    });

    it('cleans attempt-scoped state for disposed attempts', () => {
        const state = {
            disposedAttemptIds: new Set<string>(),
            streamDumpFrameCountByAttempt: new Map<string, number>([
                ['attempt-a', 4],
                ['attempt-b', 1],
            ]),
            streamDumpLastTextByAttempt: new Map<string, string>([
                ['attempt-a', 'aaa'],
                ['attempt-b', 'bbb'],
            ]),
            latestAttemptIdByPlatform: new Map<string, string>([
                ['Gemini', 'attempt-a'],
                ['Grok', 'attempt-b'],
            ]),
            attemptByConversationId: new Map<string, string>([
                ['conv-a', 'attempt-a'],
                ['conv-b', 'attempt-b'],
            ]),
        };
        cleanupDisposedAttemptState('attempt-a', state, 3);
        expect(state.disposedAttemptIds.has('attempt-a')).toBe(true);
        expect(state.streamDumpFrameCountByAttempt.has('attempt-a')).toBe(false);
        expect(state.streamDumpLastTextByAttempt.has('attempt-a')).toBe(false);
        expect(state.latestAttemptIdByPlatform.get('Gemini')).toBeUndefined();
        expect(state.attemptByConversationId.get('conv-a')).toBeUndefined();
    });
});
