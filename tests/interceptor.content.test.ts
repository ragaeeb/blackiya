import { beforeAll, describe, expect, it } from 'bun:test';

type GeminiLoadendGuard = (
    state: { emittedCompleted: boolean; emittedStreaming: boolean; seedConversationId?: string },
    requestUrl: string,
) => boolean;
type SetBoundedMapValue = <K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number) => void;
type PruneTimestampCache = (map: Map<string, number>, ttlMs: number, nowMs?: number) => number;
type CleanupDisposedAttemptState = (
    attemptId: string,
    state: {
        disposedAttemptIds: Set<string>;
        streamDumpFrameCountByAttempt: Map<string, number>;
        streamDumpLastTextByAttempt: Map<string, string>;
        latestAttemptIdByPlatform: Map<string, string>;
        attemptByConversationId: Map<string, string>;
    },
    maxDisposedAttempts?: number,
) => void;
type ShouldEmitXhrRequestLifecycle = (context: {
    shouldEmitNonChatLifecycle: boolean;
    requestAdapter: { name: string } | null;
    attemptId?: string;
    conversationId?: string;
}) => boolean;

describe('interceptor.content utilities', () => {
    let shouldEmitGeminiXhrLoadendCompletion: GeminiLoadendGuard;
    let setBoundedMapValue: SetBoundedMapValue;
    let pruneTimestampCache: PruneTimestampCache;
    let cleanupDisposedAttemptState: CleanupDisposedAttemptState;
    let shouldEmitXhrRequestLifecycle: ShouldEmitXhrRequestLifecycle;

    beforeAll(async () => {
        (globalThis as any).defineContentScript = (config: unknown) => config;
        const mod = await import('../entrypoints/interceptor.content');
        shouldEmitGeminiXhrLoadendCompletion = mod.shouldEmitGeminiXhrLoadendCompletion as GeminiLoadendGuard;
        setBoundedMapValue = mod.setBoundedMapValue as SetBoundedMapValue;
        pruneTimestampCache = mod.pruneTimestampCache as PruneTimestampCache;
        cleanupDisposedAttemptState = mod.cleanupDisposedAttemptState as CleanupDisposedAttemptState;
        shouldEmitXhrRequestLifecycle = mod.shouldEmitXhrRequestLifecycle as ShouldEmitXhrRequestLifecycle;
    });

    it('emits completed once for the same Gemini XHR state', () => {
        const state = {
            emittedCompleted: false,
            emittedStreaming: true,
            seedConversationId: 'gem-conv-1',
        };
        const streamGenerateUrl =
            'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';

        expect(shouldEmitGeminiXhrLoadendCompletion(state, streamGenerateUrl)).toBeTrue();
        expect(state.emittedCompleted).toBeTrue();
        expect(shouldEmitGeminiXhrLoadendCompletion(state, streamGenerateUrl)).toBeFalse();
    });

    it('does not emit completed without streaming or conversation context', () => {
        const state = {
            emittedCompleted: false,
            emittedStreaming: false,
        };
        const streamGenerateUrl =
            'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';
        expect(shouldEmitGeminiXhrLoadendCompletion(state, streamGenerateUrl)).toBeFalse();
    });

    it('allows Gemini XHR lifecycle emission without an initial conversation id', () => {
        expect(
            shouldEmitXhrRequestLifecycle({
                shouldEmitNonChatLifecycle: true,
                requestAdapter: { name: 'Gemini' },
                attemptId: 'gemini:attempt-1',
                conversationId: undefined,
            }),
        ).toBeTrue();

        expect(
            shouldEmitXhrRequestLifecycle({
                shouldEmitNonChatLifecycle: true,
                requestAdapter: { name: 'Grok' },
                attemptId: 'grok:attempt-1',
                conversationId: undefined,
            }),
        ).toBeFalse();
    });

    it('bounds map size and evicts oldest entries', () => {
        const map = new Map<string, number>();
        setBoundedMapValue(map, 'a', 1, 2);
        setBoundedMapValue(map, 'b', 2, 2);
        setBoundedMapValue(map, 'c', 3, 2);
        expect(map.size).toBe(2);
        expect(map.has('a')).toBeFalse();
        expect(map.has('b')).toBeTrue();
        expect(map.has('c')).toBeTrue();
    });

    it('prunes stale timestamp cache entries by ttl', () => {
        const now = 5_000;
        const map = new Map<string, number>([
            ['fresh', now - 500],
            ['stale-a', now - 5_000],
            ['stale-b', now - 8_000],
        ]);
        const removed = pruneTimestampCache(map, 2_000, now);
        expect(removed).toBe(2);
        expect(map.has('fresh')).toBeTrue();
        expect(map.has('stale-a')).toBeFalse();
        expect(map.has('stale-b')).toBeFalse();
    });

    it('cleans attempt-scoped caches when attempt is disposed', () => {
        const state = {
            disposedAttemptIds: new Set<string>(),
            streamDumpFrameCountByAttempt: new Map<string, number>([
                ['attempt-a', 9],
                ['attempt-b', 4],
            ]),
            streamDumpLastTextByAttempt: new Map<string, string>([
                ['attempt-a', 'abc'],
                ['attempt-b', 'def'],
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

        cleanupDisposedAttemptState('attempt-a', state, 2);

        expect(state.streamDumpFrameCountByAttempt.has('attempt-a')).toBeFalse();
        expect(state.streamDumpLastTextByAttempt.has('attempt-a')).toBeFalse();
        expect(state.latestAttemptIdByPlatform.get('Gemini')).toBeUndefined();
        expect(state.attemptByConversationId.get('conv-a')).toBeUndefined();
        expect(state.disposedAttemptIds.has('attempt-a')).toBeTrue();
    });

    it('promotes an existing key to most-recent on update', () => {
        const map = new Map<string, number>();
        setBoundedMapValue(map, 'a', 1, 2);
        setBoundedMapValue(map, 'b', 2, 2);
        // Refresh 'a' — it should now be most-recent, making 'b' the oldest
        setBoundedMapValue(map, 'a', 99, 2);
        setBoundedMapValue(map, 'c', 3, 2);
        // 'b' should be evicted, 'a' and 'c' survive
        expect(map.has('b')).toBeFalse();
        expect(map.get('a')).toBe(99);
        expect(map.has('c')).toBeTrue();
    });
});
