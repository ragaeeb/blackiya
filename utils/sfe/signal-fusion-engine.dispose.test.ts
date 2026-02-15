import { describe, expect, it } from 'bun:test';
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
        expect(after.ready).toBe(false);
    });
});
