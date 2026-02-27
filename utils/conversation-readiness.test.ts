import { describe, expect, it } from 'bun:test';
import { hasMeaningfulAssistantContent, isConversationReady } from '@/utils/conversation-readiness';
import type { ConversationData, Message } from '@/utils/types';

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

const buildMessage = (overrides: Partial<Message> = {}): Message => ({
    id: 'msg-1',
    author: { role: 'assistant', name: null, metadata: {} },
    create_time: 1,
    update_time: 1,
    content: { content_type: 'text', parts: ['hello'] },
    status: 'finished_successfully',
    end_turn: true,
    weight: 1,
    metadata: {},
    recipient: 'all',
    channel: null,
    ...overrides,
});

describe('hasMeaningfulAssistantContent', () => {
    it('returns false for non-assistant messages', () => {
        const msg = buildMessage({ author: { role: 'user', name: null, metadata: {} } });
        expect(hasMeaningfulAssistantContent(msg)).toBeFalse();
    });

    it('returns true when content.parts has non-empty strings', () => {
        const msg = buildMessage({ content: { content_type: 'text', parts: ['response'] } });
        expect(hasMeaningfulAssistantContent(msg)).toBeTrue();
    });

    it('returns true when content.content field is non-empty', () => {
        const msg = buildMessage({ content: { content_type: 'text', parts: [], content: 'direct content' } as any });
        expect(hasMeaningfulAssistantContent(msg)).toBeTrue();
    });

    it('returns true when content.thoughts has a non-empty summary', () => {
        const msg = buildMessage({
            content: {
                content_type: 'text',
                parts: [],
                thoughts: [{ summary: 'thinking step', content: '', chunks: [] }],
            } as any,
        });
        expect(hasMeaningfulAssistantContent(msg)).toBeTrue();
    });

    it('returns true when content.thoughts has a non-empty content field', () => {
        const msg = buildMessage({
            content: {
                content_type: 'text',
                parts: [],
                thoughts: [{ summary: '', content: 'thought content', chunks: [] }],
            } as any,
        });
        expect(hasMeaningfulAssistantContent(msg)).toBeTrue();
    });

    it('returns true when content.thoughts has a non-empty chunk', () => {
        const msg = buildMessage({
            content: {
                content_type: 'text',
                parts: [],
                thoughts: [{ summary: '', content: '', chunks: ['chunk text'] }],
            } as any,
        });
        expect(hasMeaningfulAssistantContent(msg)).toBeTrue();
    });

    it('returns false when thoughts array contains a null entry', () => {
        const msg = buildMessage({
            content: { content_type: 'text', parts: [], thoughts: [null] } as any,
        });
        expect(hasMeaningfulAssistantContent(msg)).toBeFalse();
    });

    it('returns false when thoughts array is empty', () => {
        const msg = buildMessage({
            content: { content_type: 'text', parts: [], thoughts: [] } as any,
        });
        expect(hasMeaningfulAssistantContent(msg)).toBeFalse();
    });

    it('returns true when metadata.reasoning is non-empty', () => {
        const msg = buildMessage({ metadata: { reasoning: 'chain of thought' } as any });
        expect(hasMeaningfulAssistantContent(msg)).toBeTrue();
    });

    it('returns true when metadata.thinking_trace is non-empty', () => {
        const msg = buildMessage({ metadata: { thinking_trace: 'thinking…' } as any });
        expect(hasMeaningfulAssistantContent(msg)).toBeTrue();
    });

    it('returns false when all content fields are empty', () => {
        const msg = buildMessage({
            content: { content_type: 'text', parts: [], thoughts: [] } as any,
            metadata: {},
        });
        expect(hasMeaningfulAssistantContent(msg)).toBeFalse();
    });
});

describe('isConversationReady', () => {
    it('returns false for null/non-object input', () => {
        expect(isConversationReady(null as any)).toBeFalse();
        expect(isConversationReady('string' as any)).toBeFalse();
    });

    it('returns false when mapping is missing or not an object', () => {
        expect(isConversationReady({ mapping: null } as any)).toBeFalse();
        expect(isConversationReady({ mapping: 'string' } as any)).toBeFalse();
        expect(isConversationReady({} as any)).toBeFalse();
    });

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

    it('returns false when there are no assistant messages', () => {
        const data = createBaseConversation();
        delete data.mapping['assistant-node'];
        expect(isConversationReady(data)).toBeFalse();
    });

    it('returns false when finished assistant messages have no meaningful content', () => {
        const data = createBaseConversation();
        data.mapping['assistant-node'].message!.content = {
            content_type: 'text',
            parts: [],
        };
        expect(isConversationReady(data)).toBeFalse();
    });
});
