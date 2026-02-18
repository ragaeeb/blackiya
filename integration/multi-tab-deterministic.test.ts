import { describe, expect, it } from 'bun:test';
import { ReadinessGate } from '@/utils/sfe/readiness-gate';
import { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';

const buildData = (conversationId: string) => {
    return {
        title: conversationId,
        create_time: 1,
        update_time: 2,
        mapping: {},
        conversation_id: conversationId,
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
};

describe('integration: multi-tab deterministic', () => {
    it('keeps attempts isolated across 8 concurrent conversations', () => {
        const sfe = new SignalFusionEngine({
            readinessGate: new ReadinessGate({ minStableMs: 100, maxStabilizationWaitMs: 2_000 }),
        });

        for (let i = 1; i <= 8; i++) {
            const conversationId = `c${i}`;
            const attemptId = `a${i}`;
            sfe.ingestSignal({
                attemptId,
                platform: 'ChatGPT',
                source: 'network_stream',
                phase: 'streaming',
                timestampMs: i * 100,
                conversationId,
            });
            sfe.ingestSignal({
                attemptId,
                platform: 'ChatGPT',
                source: 'completion_endpoint',
                phase: 'completed_hint',
                timestampMs: i * 100 + 20,
                conversationId,
            });

            sfe.applyCanonicalSample({
                attemptId,
                platform: 'ChatGPT',
                conversationId,
                timestampMs: i * 100 + 30,
                data: buildData(conversationId),
                readiness: {
                    ready: true,
                    terminal: true,
                    reason: 'ok',
                    contentHash: `h-${conversationId}`,
                    latestAssistantTextLength: 16,
                },
            });

            sfe.applyCanonicalSample({
                attemptId,
                platform: 'ChatGPT',
                conversationId,
                timestampMs: i * 100 + 160,
                data: buildData(conversationId),
                readiness: {
                    ready: true,
                    terminal: true,
                    reason: 'ok',
                    contentHash: `h-${conversationId}`,
                    latestAssistantTextLength: 16,
                },
            });
        }

        for (let i = 1; i <= 8; i++) {
            const conversationId = `c${i}`;
            const resolved = sfe.resolveByConversation(conversationId);
            expect(resolved?.ready).toBeTrue();
            expect(resolved?.phase).toBe('captured_ready');
            expect(resolved?.attemptId).toBe(`a${i}`);
        }
    });
});
