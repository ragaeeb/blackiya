import { describe, expect, it } from 'bun:test';
import { EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE } from '@/utils/external-api/contracts';
import type { ExportMeta } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';
import {
    buildExternalInternalEventMessage,
    createExternalEventDispatcherState,
    markExternalConversationEventDispatched,
    maybeBuildExternalConversationEvent,
} from './external-event-dispatch';

const CANONICAL_META: ExportMeta = {
    captureSource: 'canonical_api',
    fidelity: 'high',
    completeness: 'complete',
};

const buildConversation = (conversationId: string): ConversationData => ({
    title: 'Test',
    create_time: 1_700_000_000,
    update_time: 1_700_000_001,
    mapping: {
        root: { id: 'root', message: null, parent: null, children: [] },
    },
    conversation_id: conversationId,
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

const buildConversationWithTitle = (conversationId: string, title: string): ConversationData => ({
    ...buildConversation(conversationId),
    title,
});

const buildConversationWithPrompt = (
    conversationId: string,
    options: { title: string; prompt: string; answer: string },
): ConversationData => ({
    title: options.title,
    create_time: 1_700_000_000,
    update_time: 1_700_000_001,
    mapping: {
        root: { id: 'root', message: null, parent: null, children: ['user-1'] },
        'user-1': {
            id: 'user-1',
            parent: 'root',
            children: ['assistant-1'],
            message: {
                id: 'user-1',
                author: { role: 'user', name: 'User', metadata: {} },
                create_time: 1_700_000_000,
                update_time: 1_700_000_000,
                content: { content_type: 'text', parts: [options.prompt] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        },
        'assistant-1': {
            id: 'assistant-1',
            parent: 'user-1',
            children: [],
            message: {
                id: 'assistant-1',
                author: { role: 'assistant', name: 'Assistant', metadata: {} },
                create_time: 1_700_000_001,
                update_time: 1_700_000_001,
                content: { content_type: 'text', parts: [options.answer] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        },
    },
    conversation_id: conversationId,
    current_node: 'assistant-1',
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'grok-3',
    safe_urls: [],
    blocked_urls: [],
});

describe('runner/external-event-dispatch', () => {
    it('should emit conversation.ready once for first canonical-ready sample', () => {
        const state = createExternalEventDispatcherState();
        const event = maybeBuildExternalConversationEvent({
            conversationId: 'conv-1',
            data: buildConversation('conv-1'),
            providerName: 'ChatGPT',
            readinessMode: 'canonical_ready',
            captureMeta: CANONICAL_META,
            attemptId: 'attempt-1',
            shouldBlockActions: false,
            evaluateReadinessForData: () =>
                ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:1',
                    latestAssistantTextLength: 10,
                }) as any,
            state,
            now: () => 123,
            createEventId: () => 'evt-1',
        });

        expect(event).not.toBeNull();
        expect(event?.type).toBe('conversation.ready');
        expect(event?.conversation_id).toBe('conv-1');
        expect(event?.provider).toBe('chatgpt');
    });

    it('should keep dispatch state unchanged until send is acknowledged', () => {
        const state = createExternalEventDispatcherState();
        const event = maybeBuildExternalConversationEvent({
            conversationId: 'conv-1',
            data: buildConversation('conv-1'),
            providerName: 'ChatGPT',
            readinessMode: 'canonical_ready',
            captureMeta: CANONICAL_META,
            attemptId: 'attempt-1',
            shouldBlockActions: false,
            evaluateReadinessForData: () =>
                ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:1',
                    latestAssistantTextLength: 10,
                }) as any,
            state,
            now: () => 123,
            createEventId: () => 'evt-1',
        });

        expect(event).not.toBeNull();
        expect(state.byConversation.has('conv-1')).toBeFalse();
    });

    it('should not emit duplicate event when canonical hash is unchanged', () => {
        const state = createExternalEventDispatcherState();
        const baseArgs = {
            conversationId: 'conv-1',
            data: buildConversation('conv-1'),
            providerName: 'ChatGPT',
            readinessMode: 'canonical_ready',
            captureMeta: CANONICAL_META,
            attemptId: 'attempt-1',
            shouldBlockActions: false,
            evaluateReadinessForData: () =>
                ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:1',
                    latestAssistantTextLength: 10,
                }) as any,
            state,
            now: () => 123,
            createEventId: () => 'evt',
        };

        const first = maybeBuildExternalConversationEvent(baseArgs);
        expect(first).not.toBeNull();
        if (!first) {
            throw new Error('Expected first event');
        }
        markExternalConversationEventDispatched(state, 'conv-1', first.attempt_id, first.content_hash, first.payload);
        expect(maybeBuildExternalConversationEvent(baseArgs)).toBeNull();
    });

    it('should emit conversation.updated when canonical hash changes', () => {
        const state = createExternalEventDispatcherState();
        const first = maybeBuildExternalConversationEvent({
            conversationId: 'conv-1',
            data: buildConversation('conv-1'),
            providerName: 'ChatGPT',
            readinessMode: 'canonical_ready',
            captureMeta: CANONICAL_META,
            attemptId: 'attempt-1',
            shouldBlockActions: false,
            evaluateReadinessForData: () =>
                ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:1',
                    latestAssistantTextLength: 10,
                }) as any,
            state,
            now: () => 123,
            createEventId: () => 'evt-1',
        });
        expect(first).not.toBeNull();
        if (!first) {
            throw new Error('Expected first event');
        }
        markExternalConversationEventDispatched(state, 'conv-1', first.attempt_id, first.content_hash, first.payload);

        const second = maybeBuildExternalConversationEvent({
            conversationId: 'conv-1',
            data: buildConversation('conv-1'),
            providerName: 'ChatGPT',
            readinessMode: 'canonical_ready',
            captureMeta: CANONICAL_META,
            attemptId: 'attempt-2',
            shouldBlockActions: false,
            evaluateReadinessForData: () =>
                ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:2',
                    latestAssistantTextLength: 12,
                }) as any,
            state,
            now: () => 456,
            createEventId: () => 'evt-2',
        });

        expect(second).not.toBeNull();
        expect(second?.type).toBe('conversation.updated');
        expect(second?.content_hash).toBe('hash:2');
    });

    it('should not emit when readiness is not canonical-ready', () => {
        const state = createExternalEventDispatcherState();
        const event = maybeBuildExternalConversationEvent({
            conversationId: 'conv-1',
            data: buildConversation('conv-1'),
            providerName: 'ChatGPT',
            readinessMode: 'awaiting_stabilization',
            captureMeta: CANONICAL_META,
            attemptId: 'attempt-1',
            shouldBlockActions: false,
            evaluateReadinessForData: () =>
                ({
                    ready: false,
                    terminal: false,
                    reason: 'in-progress',
                    contentHash: null,
                    latestAssistantTextLength: 0,
                }) as any,
            state,
            now: () => 123,
            createEventId: () => 'evt-1',
        });

        expect(event).toBeNull();
    });

    it('should not emit when actions are blocked', () => {
        const state = createExternalEventDispatcherState();
        const event = maybeBuildExternalConversationEvent({
            conversationId: 'conv-1',
            data: buildConversation('conv-1'),
            providerName: 'ChatGPT',
            readinessMode: 'canonical_ready',
            captureMeta: CANONICAL_META,
            attemptId: 'attempt-1',
            shouldBlockActions: true,
            evaluateReadinessForData: () =>
                ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:1',
                    latestAssistantTextLength: 10,
                }) as any,
            state,
            now: () => 123,
            createEventId: () => 'evt-1',
        });

        expect(event).toBeNull();
    });

    it('should evict oldest dispatch entries when max state size is reached', () => {
        const state = createExternalEventDispatcherState(2);

        const first = maybeBuildExternalConversationEvent({
            conversationId: 'conv-1',
            data: buildConversation('conv-1'),
            providerName: 'ChatGPT',
            readinessMode: 'canonical_ready',
            captureMeta: CANONICAL_META,
            attemptId: 'attempt-1',
            shouldBlockActions: false,
            evaluateReadinessForData: () =>
                ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:1',
                    latestAssistantTextLength: 10,
                }) as any,
            state,
            now: () => 123,
            createEventId: () => 'evt-1',
        });
        expect(first).not.toBeNull();
        if (!first) {
            throw new Error('Expected first event');
        }
        markExternalConversationEventDispatched(state, 'conv-1', first.attempt_id, first.content_hash, first.payload);

        const second = maybeBuildExternalConversationEvent({
            conversationId: 'conv-2',
            data: buildConversation('conv-2'),
            providerName: 'ChatGPT',
            readinessMode: 'canonical_ready',
            captureMeta: CANONICAL_META,
            attemptId: 'attempt-2',
            shouldBlockActions: false,
            evaluateReadinessForData: () =>
                ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:2',
                    latestAssistantTextLength: 10,
                }) as any,
            state,
            now: () => 124,
            createEventId: () => 'evt-2',
        });
        expect(second).not.toBeNull();
        if (!second) {
            throw new Error('Expected second event');
        }
        markExternalConversationEventDispatched(
            state,
            'conv-2',
            second.attempt_id,
            second.content_hash,
            second.payload,
        );

        const third = maybeBuildExternalConversationEvent({
            conversationId: 'conv-3',
            data: buildConversation('conv-3'),
            providerName: 'ChatGPT',
            readinessMode: 'canonical_ready',
            captureMeta: CANONICAL_META,
            attemptId: 'attempt-3',
            shouldBlockActions: false,
            evaluateReadinessForData: () =>
                ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:3',
                    latestAssistantTextLength: 10,
                }) as any,
            state,
            now: () => 125,
            createEventId: () => 'evt-3',
        });
        expect(third).not.toBeNull();
        if (!third) {
            throw new Error('Expected third event');
        }
        markExternalConversationEventDispatched(state, 'conv-3', third.attempt_id, third.content_hash, third.payload);

        expect(state.byConversation.has('conv-1')).toBeFalse();
        expect(state.byConversation.has('conv-2')).toBeTrue();
        expect(state.byConversation.has('conv-3')).toBeTrue();
    });

    it('should emit conversation.updated when title changes but hash is unchanged', () => {
        const state = createExternalEventDispatcherState();
        const first = maybeBuildExternalConversationEvent({
            conversationId: 'conv-1',
            data: buildConversationWithTitle('conv-1', 'New chat'),
            providerName: 'ChatGPT',
            readinessMode: 'canonical_ready',
            captureMeta: CANONICAL_META,
            attemptId: 'attempt-1',
            shouldBlockActions: false,
            evaluateReadinessForData: () =>
                ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:1',
                    latestAssistantTextLength: 10,
                }) as any,
            state,
            now: () => 123,
            createEventId: () => 'evt-1',
        });
        expect(first?.type).toBe('conversation.ready');
        if (!first) {
            throw new Error('Expected first event');
        }
        markExternalConversationEventDispatched(state, 'conv-1', first.attempt_id, first.content_hash, first.payload);

        const second = maybeBuildExternalConversationEvent({
            conversationId: 'conv-1',
            data: buildConversationWithTitle('conv-1', 'Specific upgraded title'),
            providerName: 'ChatGPT',
            readinessMode: 'canonical_ready',
            captureMeta: CANONICAL_META,
            attemptId: 'attempt-1',
            shouldBlockActions: false,
            evaluateReadinessForData: () =>
                ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:1',
                    latestAssistantTextLength: 10,
                }) as any,
            state,
            now: () => 124,
            createEventId: () => 'evt-2',
        });

        expect(second).not.toBeNull();
        expect(second?.type).toBe('conversation.updated');
        expect(second?.content_hash).toBe('hash:1');
        expect(second?.payload.title).toBe('Specific upgraded title');
    });

    it('should derive a non-generic title from first user message before first external emit', () => {
        const state = createExternalEventDispatcherState();
        const event = maybeBuildExternalConversationEvent({
            conversationId: 'conv-1',
            data: buildConversationWithPrompt('conv-1', {
                title: 'New conversation',
                prompt: 'Classical Islamic Texts Translation Guidelines',
                answer: 'Draft translation notes',
            }),
            providerName: 'Grok',
            readinessMode: 'canonical_ready',
            captureMeta: CANONICAL_META,
            attemptId: 'attempt-1',
            shouldBlockActions: false,
            evaluateReadinessForData: () =>
                ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:prompt',
                    latestAssistantTextLength: 10,
                }) as any,
            state,
            now: () => 123,
            createEventId: () => 'evt-1',
        });

        expect(event).not.toBeNull();
        expect(event?.type).toBe('conversation.ready');
        expect(event?.payload.title).toBe('Classical Islamic Texts Translation Guidelines');
    });

    it('should build internal background message wrapper for emitted event', () => {
        const state = createExternalEventDispatcherState();
        const event = maybeBuildExternalConversationEvent({
            conversationId: 'conv-1',
            data: buildConversation('conv-1'),
            providerName: 'ChatGPT',
            readinessMode: 'canonical_ready',
            captureMeta: CANONICAL_META,
            attemptId: 'attempt-1',
            shouldBlockActions: false,
            evaluateReadinessForData: () =>
                ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:1',
                    latestAssistantTextLength: 10,
                }) as any,
            state,
            now: () => 123,
            createEventId: () => 'evt-1',
        });

        expect(event).not.toBeNull();
        if (!event) {
            throw new Error('Expected event');
        }
        const wrapped = buildExternalInternalEventMessage(event);
        expect(wrapped).toEqual({
            type: EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE,
            event,
        });
    });
});
