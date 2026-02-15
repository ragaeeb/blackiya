import { describe, expect, it } from 'bun:test';
import { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';

describe('integration: navigation dispose sequence', () => {
    it('disposes old in-flight attempt on route change and keeps new attempt active', () => {
        const sfe = new SignalFusionEngine();

        sfe.ingestSignal({
            attemptId: 'a1',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'streaming',
            conversationId: 'c1',
            timestampMs: 100,
        });

        sfe.dispose('a1');

        sfe.ingestSignal({
            attemptId: 'a2',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'prompt_sent',
            conversationId: 'c2',
            timestampMs: 200,
        });

        expect(sfe.resolve('a1').phase).toBe('disposed');
        expect(sfe.resolve('a2').phase).toBe('prompt_sent');
    });
});
