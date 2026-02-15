import { describe, expect, it } from 'bun:test';
import { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';

const SAMPLE_DATA = {
    title: 'x',
    create_time: 1,
    update_time: 2,
    mapping: {},
    conversation_id: 'c1',
    current_node: 'root',
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'x',
    safe_urls: [],
    blocked_urls: [],
};

describe('integration: dispose retry race', () => {
    it('drops late canonical samples after attempt disposal', () => {
        const sfe = new SignalFusionEngine();

        sfe.ingestSignal({
            attemptId: 'a1',
            platform: 'ChatGPT',
            source: 'completion_endpoint',
            phase: 'completed_hint',
            timestampMs: 100,
            conversationId: 'c1',
        });

        const disposed = sfe.dispose('a1');
        expect(disposed.phase).toBe('disposed');

        const lateSample = sfe.applyCanonicalSample({
            attemptId: 'a1',
            platform: 'ChatGPT',
            conversationId: 'c1',
            timestampMs: 200,
            data: SAMPLE_DATA,
            readiness: {
                ready: true,
                terminal: true,
                reason: 'ok',
                contentHash: 'h1',
                latestAssistantTextLength: 7,
            },
        });

        expect(lateSample.ready).toBe(false);
        expect(lateSample.phase).toBe('disposed');
        expect(lateSample.blockingConditions).toContain('disposed');
    });
});
