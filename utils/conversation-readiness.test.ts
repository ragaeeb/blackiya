import { describe, expect, it } from 'bun:test';
import { isConversationReady } from '@/utils/conversation-readiness';
import type { ConversationData } from '@/utils/types';

const createBaseConversation = (): ConversationData => {
    return {
        title: 'Test',
        create_time: 1_700_000_000,
        update_time: 1_700_000_010,
        conversation_id: '11111111-2222-3333-4444-555555555555',
        current_node: 'assistant-node',
        mapping: {
            root: { id: 'root', message: null, parent: null, children: ['user-node'] },
            'user-node': {
                id: 'user-node',
                parent: 'root',
                children: ['assistant-node'],
                message: {
                    id: 'user-node',
                    author: { role: 'user', name: null, metadata: {} },
                    create_time: 1_700_000_001,
                    update_time: 1_700_000_001,
                    content: { content_type: 'text', parts: ['hello'] },
                    status: 'finished_successfully',
                    end_turn: true,
                    weight: 1,
                    metadata: {},
                    recipient: 'all',
                    channel: null,
                },
            },
            'assistant-node': {
                id: 'assistant-node',
                parent: 'user-node',
                children: [],
                message: {
                    id: 'assistant-node',
                    author: { role: 'assistant', name: null, metadata: {} },
                    create_time: 1_700_000_002,
                    update_time: 1_700_000_002,
                    content: { content_type: 'text', parts: ['response'] },
                    status: 'finished_successfully',
                    end_turn: true,
                    weight: 1,
                    metadata: {},
                    recipient: 'all',
                    channel: null,
                },
            },
        },
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: 'test-model',
        safe_urls: [],
        blocked_urls: [],
    };
};

describe('conversation readiness', () => {
    it('returns true for finished assistant message with non-empty parts', () => {
        const data = createBaseConversation();
        expect(isConversationReady(data)).toBeTrue();
    });

    it('returns false for assistant messages with empty content payloads', () => {
        const data = createBaseConversation();
        data.mapping['assistant-node'].message!.content = {
            content_type: 'model_editable_context' as any,
            parts: [],
        };
        expect(isConversationReady(data)).toBeFalse();
    });

    it('returns false when assistant is still in progress', () => {
        const data = createBaseConversation();
        data.mapping['assistant-node'].message!.status = 'in_progress';
        expect(isConversationReady(data)).toBeFalse();
    });
});
