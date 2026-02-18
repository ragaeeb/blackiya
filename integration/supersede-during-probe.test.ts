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

describe('integration: supersede during probe', () => {
    it('prevents stale attempt from reaching captured_ready after supersede', () => {
        const sfe = new SignalFusionEngine();

        sfe.ingestSignal({
            attemptId: 'a1',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'completed_hint',
            conversationId: 'c1',
            timestampMs: 100,
        });

        sfe.ingestSignal({
            attemptId: 'a2',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'prompt_sent',
            conversationId: 'c1',
            timestampMs: 150,
        });

        const stale = sfe.applyCanonicalSample({
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
                latestAssistantTextLength: 5,
            },
        });

        expect(stale.phase).toBe('superseded');
        expect(stale.ready).toBeFalse();
    });
});
