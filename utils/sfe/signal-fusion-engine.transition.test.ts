import { describe, expect, it } from 'bun:test';
import { ReadinessGate } from '@/utils/sfe/readiness-gate';
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

    it('preserves blocking conditions when resolving by conversation', () => {
        const sfe = new SignalFusionEngine({
            readinessGate: new ReadinessGate({ minStableMs: 1000, maxStabilizationWaitMs: 200 }),
        });
        sfe.ingestSignal({
            attemptId: 'a1',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'completed_hint',
            timestampMs: 1000,
            conversationId: 'c1',
        });

        sfe.applyCanonicalSample({
            attemptId: 'a1',
            platform: 'ChatGPT',
            conversationId: 'c1',
            timestampMs: 1000,
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
                latestAssistantTextLength: 8,
            },
        });

        const timedOut = sfe.applyCanonicalSample({
            attemptId: 'a1',
            platform: 'ChatGPT',
            conversationId: 'c1',
            timestampMs: 1250,
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
                contentHash: 'h2',
                latestAssistantTextLength: 8,
            },
        });
        expect(timedOut.blockingConditions).toContain('stabilization_timeout');

        const resolved = sfe.resolveByConversation('c1');
        expect(resolved?.blockingConditions).toContain('stabilization_timeout');
    });
});
