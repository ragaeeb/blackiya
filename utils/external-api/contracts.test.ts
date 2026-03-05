import { describe, expect, it } from 'bun:test';
import type { ConversationData } from '@/utils/types';
import {
    EXTERNAL_API_VERSION,
    EXTERNAL_PUSH_EVENT_TYPES,
    isExternalCommitMessage,
    isExternalConversationEvent,
    isExternalInternalEventMessage,
    isExternalPortInboundMessage,
    isExternalRequest,
    isExternalSubscribeMessage,
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

    it('should accept valid events.getSince request', () => {
        expect(
            isExternalRequest({
                api: EXTERNAL_API_VERSION,
                type: 'events.getSince',
                cursor: 10,
                limit: 50,
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
                seq: 1,
                created_at: 123,
                ts: Date.now(),
                format: 'original',
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
                seq: 2,
                created_at: 456,
                ts: Date.now(),
                format: 'original',
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
                seq: 1,
                created_at: 123,
                ts: Date.now(),
                format: 'original',
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

    it('should reject non-integer sequence and timestamp fields', () => {
        expect(
            isExternalConversationEvent({
                api: EXTERNAL_API_VERSION,
                type: 'conversation.ready',
                event_id: 'evt-fractional',
                seq: 1.5,
                created_at: 123,
                ts: Date.now(),
                format: 'original',
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
        ).toBeFalse();

        expect(
            isExternalInternalEventMessage({
                type: 'BLACKIYA_EXTERNAL_EVENT',
                event: {
                    api: EXTERNAL_API_VERSION,
                    type: 'conversation.ready',
                    event_id: 'evt-bad-ts',
                    ts: 123.45,
                    format: 'original',
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
        ).toBeFalse();

        expect(
            isExternalRequest({
                api: EXTERNAL_API_VERSION,
                type: 'events.getSince',
                cursor: 1.5,
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
                    format: 'original',
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

    it('should accept common-formatted conversation event envelope', () => {
        expect(
            isExternalConversationEvent({
                api: EXTERNAL_API_VERSION,
                type: 'conversation.ready',
                event_id: 'evt-common-1',
                seq: 3,
                created_at: 789,
                ts: Date.now(),
                format: 'common',
                provider: 'chatgpt',
                conversation_id: 'conv-1',
                payload: {
                    format: 'common',
                    llm: 'ChatGPT',
                    prompt: 'User prompt',
                    response: 'Assistant response',
                    reasoning: [],
                },
                capture_meta: {
                    captureSource: 'canonical_api',
                    fidelity: 'high',
                    completeness: 'complete',
                },
                content_hash: 'hash:common',
            }),
        ).toBeTrue();
    });

    it('should reject common-formatted event with original payload shape', () => {
        expect(
            isExternalConversationEvent({
                api: EXTERNAL_API_VERSION,
                type: 'conversation.ready',
                event_id: 'evt-common-invalid',
                seq: 4,
                created_at: 790,
                ts: Date.now(),
                format: 'common',
                provider: 'chatgpt',
                conversation_id: 'conv-1',
                payload: buildConversation(),
                capture_meta: {
                    captureSource: 'canonical_api',
                    fidelity: 'high',
                    completeness: 'complete',
                },
                content_hash: 'hash:common-invalid',
            }),
        ).toBeFalse();
    });

    it('should validate subscribe and commit control messages', () => {
        expect(
            isExternalSubscribeMessage({
                type: 'subscribe',
                cursor: 0,
                consumer_role: 'delivery',
                max_batch: 100,
                payload_format: 'common',
            }),
        ).toBeTrue();
        expect(
            isExternalCommitMessage({
                type: 'commit',
                up_to_seq: 42,
            }),
        ).toBeTrue();
        expect(isExternalPortInboundMessage({ type: 'commit', up_to_seq: 42 })).toBeTrue();
        expect(isExternalPortInboundMessage({ type: 'subscribe', cursor: 0, consumer_role: 'delivery' })).toBeTrue();

        expect(isExternalSubscribeMessage({ type: 'subscribe', cursor: -1, consumer_role: 'delivery' })).toBeFalse();
        expect(isExternalSubscribeMessage({ type: 'subscribe', cursor: 1.5, consumer_role: 'delivery' })).toBeFalse();
        expect(
            isExternalSubscribeMessage({ type: 'subscribe', cursor: Number.NaN, consumer_role: 'delivery' }),
        ).toBeFalse();
        expect(
            isExternalSubscribeMessage({
                type: 'subscribe',
                cursor: Number.POSITIVE_INFINITY,
                consumer_role: 'delivery',
            }),
        ).toBeFalse();
        expect(isExternalSubscribeMessage({ type: 'subscribe', cursor: 0, consumer_role: '' })).toBeFalse();
        expect(isExternalSubscribeMessage({ type: 'subscribe', cursor: 0, consumer_role: 'invalid_role' })).toBeFalse();
        expect(
            isExternalSubscribeMessage({
                type: 'subscribe',
                cursor: 0,
                consumer_role: 'delivery',
                payload_format: 'both',
            }),
        ).toBeFalse();

        expect(isExternalCommitMessage({ type: 'commit', up_to_seq: -1 })).toBeFalse();
        expect(isExternalCommitMessage({ type: 'commit', up_to_seq: 3.14 })).toBeFalse();
        expect(isExternalCommitMessage({ type: 'commit', up_to_seq: Number.NaN })).toBeFalse();
        expect(isExternalCommitMessage({ type: 'commit', up_to_seq: Number.POSITIVE_INFINITY })).toBeFalse();
        expect(isExternalPortInboundMessage({ type: 'commit', up_to_seq: Number.NaN })).toBeFalse();
        expect(isExternalPortInboundMessage({ type: 'commit', up_to_seq: 1.5 })).toBeFalse();
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
