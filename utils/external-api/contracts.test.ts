import { describe, expect, it } from 'bun:test';
import type { ConversationData } from '@/utils/types';
import {
    EXTERNAL_API_VERSION,
    EXTERNAL_PUSH_EVENT_TYPES,
    isExternalConversationEvent,
    isExternalInternalEventMessage,
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

    it('should accept valid conversation.getById request', () => {
        expect(
            isExternalRequest({
                api: EXTERNAL_API_VERSION,
                type: 'conversation.getById',
                conversation_id: 'conv-1',
                format: 'original',
            }),
        ).toBeTrue();
    });

    it('should reject invalid conversation.getById request conversation_id', () => {
        expect(
            isExternalRequest({
                api: EXTERNAL_API_VERSION,
                type: 'conversation.getById',
                conversation_id: '',
            }),
        ).toBeFalse();
        expect(
            isExternalRequest({
                api: EXTERNAL_API_VERSION,
                type: 'conversation.getById',
            }),
        ).toBeFalse();
    });

    it('should accept health.ping request', () => {
        expect(
            isExternalRequest({
                api: EXTERNAL_API_VERSION,
                type: 'health.ping',
            }),
        ).toBeTrue();
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

    it('should accept conversation event envelope when content_hash is null and attempt_id is undefined', () => {
        expect(
            isExternalConversationEvent({
                api: EXTERNAL_API_VERSION,
                type: 'conversation.updated',
                event_id: 'evt-2',
                ts: Date.now(),
                provider: 'chatgpt',
                conversation_id: 'conv-1',
                payload: buildConversation(),
                capture_meta: {
                    captureSource: 'canonical_api',
                    fidelity: 'high',
                    completeness: 'complete',
                },
                content_hash: null,
                attempt_id: undefined,
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

    it('should reject conversation event envelope missing capture_meta', () => {
        expect(
            isExternalConversationEvent({
                api: EXTERNAL_API_VERSION,
                type: 'conversation.ready',
                event_id: 'evt-3',
                ts: Date.now(),
                provider: 'chatgpt',
                conversation_id: 'conv-1',
                payload: buildConversation(),
                content_hash: 'hash:1',
            }),
        ).toBeFalse();
    });

    it('should validate external internal event wrapper', () => {
        expect(
            isExternalInternalEventMessage({
                type: 'BLACKIYA_EXTERNAL_EVENT',
                event: {
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
                },
            }),
        ).toBeTrue();

        expect(
            isExternalInternalEventMessage({
                type: 'BLACKIYA_EXTERNAL_EVENT',
                event: {
                    api: EXTERNAL_API_VERSION,
                    type: 'conversation.ready',
                },
            }),
        ).toBeFalse();
    });

    it('should normalize adapter/provider names', () => {
        expect(normalizeExternalProvider('ChatGPT')).toBe('chatgpt');
        expect(normalizeExternalProvider('Gemini')).toBe('gemini');
        expect(normalizeExternalProvider('Grok')).toBe('grok');
        expect(normalizeExternalProvider('Unknown Platform')).toBe('unknown');
    });

    it('should expose a single-source push event type registry', () => {
        expect(EXTERNAL_PUSH_EVENT_TYPES).toEqual(['conversation.ready', 'conversation.updated']);
    });
});
