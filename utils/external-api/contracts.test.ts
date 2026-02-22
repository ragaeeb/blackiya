import { describe, expect, it } from 'bun:test';
import type { ConversationData } from '@/utils/types';
import {
    EXTERNAL_API_VERSION,
    isExternalConversationEvent,
    isExternalRequest,
    normalizeExternalProvider,
} from './contracts';

const buildConversation = (): ConversationData => ({
    title: 'Test',
    create_time: 1_700_000_000,
    update_time: 1_700_000_001,
    mapping: {
        root: { id: 'root', message: null, parent: null, children: [] },
    },
    conversation_id: 'conv-1',
    current_node: 'root',
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'gpt',
    safe_urls: [],
    blocked_urls: [],
});

describe('external-api/contracts', () => {
    it('should accept valid conversation.getLatest request', () => {
        expect(
            isExternalRequest({
                api: EXTERNAL_API_VERSION,
                type: 'conversation.getLatest',
                format: 'common',
            }),
        ).toBeTrue();
    });

    it('should reject invalid request api version', () => {
        expect(
            isExternalRequest({
                api: 'blackiya.events.v0',
                type: 'conversation.getLatest',
            }),
        ).toBeFalse();
    });

    it('should accept valid conversation event envelope', () => {
        expect(
            isExternalConversationEvent({
                api: EXTERNAL_API_VERSION,
                type: 'conversation.ready',
                event_id: 'evt-1',
                ts: Date.now(),
                provider: 'chatgpt',
                conversation_id: 'conv-1',
                payload: buildConversation(),
                capture_meta: {
                    captureSource: 'canonical_api',
                    fidelity: 'high',
                    completeness: 'complete',
                },
                content_hash: 'hash:1',
            }),
        ).toBeTrue();
    });

    it('should reject invalid conversation event envelope payload', () => {
        expect(
            isExternalConversationEvent({
                api: EXTERNAL_API_VERSION,
                type: 'conversation.ready',
                event_id: 'evt-1',
                ts: Date.now(),
                provider: 'chatgpt',
                conversation_id: 'conv-1',
                payload: { nope: true },
                capture_meta: {
                    captureSource: 'canonical_api',
                    fidelity: 'high',
                    completeness: 'complete',
                },
                content_hash: 'hash:1',
            }),
        ).toBeFalse();
    });

    it('should normalize adapter/provider names', () => {
        expect(normalizeExternalProvider('ChatGPT')).toBe('chatgpt');
        expect(normalizeExternalProvider('Gemini')).toBe('gemini');
        expect(normalizeExternalProvider('Grok')).toBe('grok');
        expect(normalizeExternalProvider('Unknown Platform')).toBe('unknown');
    });
});
