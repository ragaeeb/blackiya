import { describe, expect, it } from 'bun:test';
import { AttemptTracker } from '@/utils/sfe/attempt-tracker';
import { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';

describe('SignalFusionEngine dispose', () => {
    it('prevents post-dispose signals from mutating readiness', () => {
        const sfe = new SignalFusionEngine();
        sfe.ingestSignal({
            attemptId: 'a1',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'streaming',
            timestampMs: 100,
            conversationId: 'c1',
        });

        const disposed = sfe.dispose('a1');
        expect(disposed.phase).toBe('disposed');

        const after = sfe.ingestSignal({
            attemptId: 'a1',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'completed_hint',
            timestampMs: 200,
            conversationId: 'c1',
        });
        expect(after.phase).toBe('disposed');
        expect(after.ready).toBeFalse();
    });

    it('prunes stale terminal resolutions when tracker no longer retains the attempt', () => {
        let now = 1_000;
        const tracker = new AttemptTracker({
            completedAttemptTtlMs: 50,
            now: () => now,
        });
        const sfe = new SignalFusionEngine({
            tracker,
            now: () => now,
            terminalResolutionTtlMs: 50,
            maxResolutions: 8,
            pruneMinIntervalMs: 0,
        });
        sfe.ingestSignal({
            attemptId: 'old',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'streaming',
            timestampMs: now,
            conversationId: 'c-old',
        });
        sfe.dispose('old');
        expect(sfe.resolve('old').phase).toBe('disposed');

        now = 1_300;
        sfe.ingestSignal({
            attemptId: 'fresh',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'prompt_sent',
            timestampMs: now,
            conversationId: 'c-fresh',
        });

        // Old attempt should no longer be retained; resolve falls back to not_captured.
        const oldResolution = sfe.resolve('old');
        expect(oldResolution.phase).toBe('idle');
        expect(oldResolution.reason).toBe('not_captured');
    });
});
