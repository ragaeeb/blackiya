import { describe, expect, it } from 'bun:test';
import {
    createExternalEventDispatcherState,
    markExternalConversationEventDispatched,
    maybeBuildExternalConversationEvent,
} from '@/utils/runner/external-event-dispatch';
import type { ConversationData } from '@/utils/types';

const buildAssistantOnlyConversation = (conversationId: string): ConversationData => ({
    title: 'Gemini Conversation',
    create_time: 1,
    update_time: 2,
    mapping: {
        root: { id: 'root', message: null, parent: null, children: ['assistant-1'] },
        'assistant-1': {
            id: 'assistant-1',
            parent: 'root',
            children: [],
            message: {
                id: 'assistant-1',
                author: { role: 'assistant', name: 'Gemini', metadata: {} },
                create_time: 1,
                update_time: 2,
                content: { content_type: 'text', parts: ['assistant only'] },
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
    default_model_slug: 'gemini-2.5-pro',
    safe_urls: [],
    blocked_urls: [],
});

const buildPromptedConversation = (conversationId: string): ConversationData => ({
    title: 'Gemini Conversation',
    create_time: 1,
    update_time: 3,
    mapping: {
        root: { id: 'root', message: null, parent: null, children: ['user-1'] },
        'user-1': {
            id: 'user-1',
            parent: 'root',
            children: ['assistant-1'],
            message: {
                id: 'user-1',
                author: { role: 'user', name: 'User', metadata: {} },
                create_time: 1,
                update_time: 1,
                content: { content_type: 'text', parts: ['Prompt text'] },
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
                author: { role: 'assistant', name: 'Gemini', metadata: {} },
                create_time: 2,
                update_time: 3,
                content: { content_type: 'text', parts: ['Final answer'] },
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
    default_model_slug: 'gemini-2.5-pro',
    safe_urls: [],
    blocked_urls: [],
});

describe('integration: gemini external ready gate', () => {
    it('should emit ready only after Gemini payload includes a non-empty user prompt', () => {
        const state = createExternalEventDispatcherState();
        const evaluateReadinessForData = () => ({
            ready: true,
            terminal: true,
            reason: 'terminal',
            contentHash: 'hash-1',
            latestAssistantTextLength: 10,
        });

        const blocked = maybeBuildExternalConversationEvent({
            conversationId: 'gemini-conv',
            data: buildAssistantOnlyConversation('gemini-conv'),
            providerName: 'Gemini',
            readinessMode: 'canonical_ready',
            captureMeta: { captureSource: 'canonical_api', fidelity: 'high', completeness: 'complete' },
            attemptId: 'gemini:attempt-1',
            shouldBlockActions: false,
            evaluateReadinessForData,
            state,
        });
        expect(blocked).toBeNull();

        const ready = maybeBuildExternalConversationEvent({
            conversationId: 'gemini-conv',
            data: buildPromptedConversation('gemini-conv'),
            providerName: 'Gemini',
            readinessMode: 'canonical_ready',
            captureMeta: { captureSource: 'canonical_api', fidelity: 'high', completeness: 'complete' },
            attemptId: 'gemini:attempt-2',
            shouldBlockActions: false,
            evaluateReadinessForData: () => ({
                ready: true,
                terminal: true,
                reason: 'terminal',
                contentHash: 'hash-2',
                latestAssistantTextLength: 12,
            }),
            state,
        });
        expect(ready?.type).toBe('conversation.ready');
        expect(ready?.provider).toBe('gemini');
        expect(ready?.content_hash).toBe('hash-2');

        markExternalConversationEventDispatched(
            state,
            'gemini-conv',
            ready?.attempt_id ?? 'gemini:attempt-2',
            'hash-2',
            ready?.payload.title ?? 'Gemini Conversation',
        );
        const duplicate = maybeBuildExternalConversationEvent({
            conversationId: 'gemini-conv',
            data: buildPromptedConversation('gemini-conv'),
            providerName: 'Gemini',
            readinessMode: 'canonical_ready',
            captureMeta: { captureSource: 'canonical_api', fidelity: 'high', completeness: 'complete' },
            attemptId: 'gemini:attempt-3',
            shouldBlockActions: false,
            evaluateReadinessForData: () => ({
                ready: true,
                terminal: true,
                reason: 'terminal',
                contentHash: 'hash-2',
                latestAssistantTextLength: 12,
            }),
            state,
        });
        expect(duplicate).toBeNull();
    });
});
