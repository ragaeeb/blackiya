import { describe, expect, it } from 'bun:test';
import { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';

describe('SignalFusionEngine supersede', () => {
    it('supersedes prior attempt for same conversation', () => {
        const sfe = new SignalFusionEngine();

        sfe.ingestSignal({
            attemptId: 'a1',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'prompt_sent',
            timestampMs: 100,
            conversationId: 'c1',
        });

        sfe.ingestSignal({
            attemptId: 'a2',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'prompt_sent',
            timestampMs: 120,
            conversationId: 'c1',
        });

        const old = sfe.resolve('a1');
        const current = sfe.resolve('a2');

        expect(old.phase).toBe('superseded');
        expect(current.phase).toBe('prompt_sent');
    });

    it('old attempt never becomes ready after supersede', () => {
        const sfe = new SignalFusionEngine();
        sfe.ingestSignal({
            attemptId: 'a1',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'prompt_sent',
            timestampMs: 100,
            conversationId: 'c1',
        });
        sfe.ingestSignal({
            attemptId: 'a2',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'prompt_sent',
            timestampMs: 110,
            conversationId: 'c1',
        });

        const oldSample = sfe.applyCanonicalSample({
            attemptId: 'a1',
            platform: 'ChatGPT',
            conversationId: 'c1',
            timestampMs: 200,
            data: {
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
            },
            readiness: {
                ready: true,
                terminal: true,
                reason: 'ok',
                contentHash: 'h1',
                latestAssistantTextLength: 10,
            },
        });

        expect(oldSample.ready).toBe(false);
        expect(oldSample.phase).toBe('superseded');
    });
});
