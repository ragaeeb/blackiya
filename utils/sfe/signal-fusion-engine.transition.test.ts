import { describe, expect, it } from 'bun:test';
import { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';

describe('SignalFusionEngine transitions', () => {
    it('moves through prompt -> streaming -> completed_hint without readiness', () => {
        const sfe = new SignalFusionEngine();

        const prompt = sfe.ingestSignal({
            attemptId: 'a1',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'prompt_sent',
            timestampMs: 100,
            conversationId: 'c1',
        });
        expect(prompt.phase).toBe('prompt_sent');

        const streaming = sfe.ingestSignal({
            attemptId: 'a1',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'streaming',
            timestampMs: 200,
            conversationId: 'c1',
        });
        expect(streaming.phase).toBe('streaming');

        const completedHint = sfe.ingestSignal({
            attemptId: 'a1',
            platform: 'ChatGPT',
            source: 'completion_endpoint',
            phase: 'completed_hint',
            timestampMs: 300,
            conversationId: 'c1',
        });
        expect(completedHint.phase).toBe('completed_hint');
        expect(completedHint.ready).toBe(false);
    });

    it('ignores regressive transitions', () => {
        const sfe = new SignalFusionEngine();
        sfe.ingestSignal({
            attemptId: 'a1',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'streaming',
            timestampMs: 100,
        });

        const regressive = sfe.ingestSignal({
            attemptId: 'a1',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'prompt_sent',
            timestampMs: 200,
        });

        expect(regressive.phase).toBe('streaming');
    });

    it('returns not_captured for unknown attempt resolution', () => {
        const sfe = new SignalFusionEngine({ now: () => 999 });
        const unknown = sfe.resolve('missing');
        expect(unknown.ready).toBe(false);
        expect(unknown.reason).toBe('not_captured');
        expect(unknown.updatedAtMs).toBe(999);
    });
});
