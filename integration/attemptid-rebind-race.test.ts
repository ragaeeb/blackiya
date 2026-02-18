import { describe, expect, it } from 'bun:test';
import { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';

const BASE_DATA = {
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

describe('integration: attemptId rebind race', () => {
    it('keeps rebinding deterministic and ignores stale canonical samples from superseded attempt IDs', () => {
        const sfe = new SignalFusionEngine();

        // Temporary attempt starts before conversation ID is resolved.
        sfe.ingestSignal({
            attemptId: 'temp-attempt',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'streaming',
            timestampMs: 100,
        });

        // Conversation ID gets resolved later for the temporary attempt.
        sfe.getAttemptTracker().updateConversationId('temp-attempt', 'c1', 130);

        // A newer attempt for the same conversation supersedes the temp attempt.
        sfe.ingestSignal({
            attemptId: 'final-attempt',
            platform: 'ChatGPT',
            source: 'network_stream',
            phase: 'prompt_sent',
            timestampMs: 150,
            conversationId: 'c1',
        });

        const stale = sfe.applyCanonicalSample({
            attemptId: 'temp-attempt',
            platform: 'ChatGPT',
            conversationId: 'c1',
            timestampMs: 200,
            data: BASE_DATA,
            readiness: {
                ready: true,
                terminal: true,
                reason: 'ok',
                contentHash: 'h1',
                latestAssistantTextLength: 12,
            },
        });

        expect(stale.ready).toBeFalse();
        expect(stale.phase).toBe('superseded');

        const active = sfe.resolveByConversation('c1');
        expect(active?.attemptId).toBe('final-attempt');
        expect(active?.phase).toBe('prompt_sent');
    });
});
