import { describe, expect, it } from 'bun:test';
import { ReadinessGate } from '@/utils/sfe/readiness-gate';

const READY_SAMPLE = {
    ready: true,
    terminal: true,
    reason: 'ok',
    contentHash: 'hash-1',
    latestAssistantTextLength: 20,
};

describe('ReadinessGate', () => {
    it('blocks when no canonical data', () => {
        const gate = new ReadinessGate();
        const result = gate.evaluate('a1', {
            ...READY_SAMPLE,
            contentHash: null,
            latestAssistantTextLength: 0,
        });
        expect(result.ready).toBe(false);
        expect(result.blockingConditions).toContain('no_canonical_data');
    });

    it('requires stable second sample before ready', () => {
        const gate = new ReadinessGate({ minStableMs: 100 });
        const first = gate.evaluate('a1', READY_SAMPLE, 1000);
        expect(first.ready).toBe(false);
        expect(first.blockingConditions).toContain('awaiting_second_sample');

        const secondTooEarly = gate.evaluate('a1', READY_SAMPLE, 1050);
        expect(secondTooEarly.ready).toBe(false);
        expect(secondTooEarly.blockingConditions).toContain('stability_window_not_elapsed');

        const secondStable = gate.evaluate('a1', READY_SAMPLE, 1120);
        expect(secondStable.ready).toBe(true);
    });

    it('resets stability when content hash changes', () => {
        const gate = new ReadinessGate({ minStableMs: 100 });
        gate.evaluate('a1', READY_SAMPLE, 1000);
        const changed = gate.evaluate('a1', { ...READY_SAMPLE, contentHash: 'hash-2' }, 1200);
        expect(changed.ready).toBe(false);
        expect(changed.blockingConditions).toContain('content_hash_changed');
    });
});
