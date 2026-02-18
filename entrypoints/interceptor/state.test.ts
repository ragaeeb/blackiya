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
        expect(map.has('fresh')).toBeTrue();
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
        expect(state.disposedAttemptIds.has('attempt-a')).toBeTrue();
        expect(state.streamDumpFrameCountByAttempt.has('attempt-a')).toBeFalse();
        expect(state.streamDumpLastTextByAttempt.has('attempt-a')).toBeFalse();
        expect(state.latestAttemptIdByPlatform.get('Gemini')).toBeUndefined();
        expect(state.attemptByConversationId.get('conv-a')).toBeUndefined();

        expect(state.streamDumpFrameCountByAttempt.get('attempt-b')).toBe(1);
        expect(state.streamDumpLastTextByAttempt.get('attempt-b')).toBe('bbb');
        expect(state.latestAttemptIdByPlatform.get('Grok')).toBe('attempt-b');
        expect(state.attemptByConversationId.get('conv-b')).toBe('attempt-b');
    });

    it('evicts oldest disposed attempt when bounded set overflows', () => {
        const state = {
            disposedAttemptIds: new Set<string>(['old-1', 'old-2']),
            streamDumpFrameCountByAttempt: new Map<string, number>(),
            streamDumpLastTextByAttempt: new Map<string, string>(),
            latestAttemptIdByPlatform: new Map<string, string>(),
            attemptByConversationId: new Map<string, string>(),
        };
        cleanupDisposedAttemptState('attempt-a', state, 3);
        cleanupDisposedAttemptState('attempt-b', state, 3);

        expect(state.disposedAttemptIds.has('old-1')).toBeFalse();
        expect(state.disposedAttemptIds.has('old-2')).toBeTrue();
        expect(state.disposedAttemptIds.has('attempt-a')).toBeTrue();
        expect(state.disposedAttemptIds.has('attempt-b')).toBeTrue();
    });
});
