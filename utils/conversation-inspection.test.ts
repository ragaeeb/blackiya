import { describe, expect, it } from 'bun:test';
import { extractAllAssistantText, extractLatestTurnPromptAndResponse } from '@/utils/conversation-inspection';
import type { ConversationData, Message, MessageNode } from '@/utils/types';

const buildMessage = (
    id: string,
    role: Message['author']['role'],
    text: string,
    createTime: number,
    updateTime = createTime,
): Message => ({
    id,
    author: { role, name: role, metadata: {} },
    create_time: createTime,
    update_time: updateTime,
    content: { content_type: 'text', parts: text ? [text] : [] },
    status: 'finished_successfully',
    end_turn: true,
    weight: 1,
    metadata: {},
    recipient: 'all',
    channel: null,
});

const buildNode = (
    id: string,
    message: Message | null,
    parent: string | null,
    children: string[] = [],
): MessageNode => ({
    id,
    message,
    parent,
    children,
});

const buildConversation = (mapping: Record<string, MessageNode>, currentNode: string): ConversationData => ({
    title: 'Conversation',
    create_time: 1,
    update_time: 1,
    mapping,
    conversation_id: 'conv-1',
    current_node: currentNode,
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'grok-3',
    safe_urls: [],
    blocked_urls: [],
});

describe('conversation inspection', () => {
    it('should use update_time recency when selecting the latest fallback node chain', () => {
        const userOld = buildMessage('user-old', 'user', 'Old prompt', 10, 10);
        const assistantOld = buildMessage('assistant-old', 'assistant', 'Old answer', 11, 11);
        const userFresh = buildMessage('user-fresh', 'user', 'Fresh prompt', 1, 19);
        const assistantFresh = buildMessage('assistant-fresh', 'assistant', 'Fresh answer', 2, 20);

        const conversation = buildConversation(
            {
                root: buildNode('root', null, null, ['user-old', 'user-fresh']),
                'user-old': buildNode('user-old', userOld, 'root', ['assistant-old']),
                'assistant-old': buildNode('assistant-old', assistantOld, 'user-old'),
                'user-fresh': buildNode('user-fresh', userFresh, 'root', ['assistant-fresh']),
                'assistant-fresh': buildNode('assistant-fresh', assistantFresh, 'user-fresh'),
            },
            'missing-current-node',
        );

        expect(extractLatestTurnPromptAndResponse(conversation)).toEqual({
            prompt: 'Fresh prompt',
            response: 'Fresh answer',
        });
    });

    it('should keep the latest turn paired when the current node is a pending user message', () => {
        const conversation = buildConversation(
            {
                root: buildNode('root', null, null, ['user-1']),
                'user-1': buildNode('user-1', buildMessage('user-1', 'user', 'Earlier prompt', 1), 'root', [
                    'assistant-1',
                ]),
                'assistant-1': buildNode(
                    'assistant-1',
                    buildMessage('assistant-1', 'assistant', 'Earlier answer', 2),
                    'user-1',
                    ['user-2'],
                ),
                'user-2': buildNode('user-2', buildMessage('user-2', 'user', 'Latest prompt', 3), 'assistant-1'),
            },
            'user-2',
        );

        expect(extractLatestTurnPromptAndResponse(conversation)).toEqual({
            prompt: 'Latest prompt',
            response: '',
        });
    });

    it('should order assistant text chronologically instead of by mapping insertion order', () => {
        const olderAssistant = buildMessage('assistant-older', 'assistant', 'First answer', 1, 1);
        const newerAssistant = buildMessage('assistant-newer', 'assistant', 'Second answer', 2, 2);

        const conversation = buildConversation(
            {
                root: buildNode('root', null, null, ['assistant-newer', 'assistant-older']),
                'assistant-newer': buildNode('assistant-newer', newerAssistant, 'root'),
                'assistant-older': buildNode('assistant-older', olderAssistant, 'root'),
            },
            'assistant-newer',
        );

        expect(extractAllAssistantText(conversation)).toBe('First answer\n\nSecond answer');
    });
});
