import { describe, expect, it } from 'bun:test';
import { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';

describe('integration: existing conversation load', () => {
    it('reaches captured_ready for completed conversation without prompt lifecycle via canonical samples', () => {
        const sfe = new SignalFusionEngine();

        const sample = {
            attemptId: 'synthetic:c1',
            platform: 'ChatGPT',
            conversationId: 'c1',
            data: {
                title: 'loaded',
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
            },
            readiness: {
                ready: true,
                terminal: true,
                reason: 'ok',
                contentHash: 'h1',
                latestAssistantTextLength: 10,
            },
        };

        const first = sfe.applyCanonicalSample({ ...sample, timestampMs: 1000 });
        expect(first.ready).toBeFalse();

        const second = sfe.applyCanonicalSample({ ...sample, timestampMs: 2200 });
        expect(second.ready).toBeTrue();
        expect(second.phase).toBe('captured_ready');
    });
});
