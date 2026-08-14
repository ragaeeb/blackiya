import { describe, expect, it } from 'bun:test';
import { conversationToMarkdown } from '@/utils/markdown-transcript';
import type { Author, ConversationData, Message, MessageContent, MessageNode } from '@/utils/types';

const message = (
    id: string,
    role: Author['role'],
    content: MessageContent,
    metadata: Record<string, unknown> = {},
): Message => ({
    id,
    author: { role, name: null, metadata: {} },
    create_time: 1,
    update_time: 1,
    content,
    status: 'finished_successfully',
    end_turn: true,
    weight: 1,
    metadata,
    recipient: 'all',
    channel: null,
});

const node = (id: string, parent: string | null, children: string[], value: Message | null): MessageNode => ({
    id,
    parent,
    children,
    message: value,
});

const conversation = (): ConversationData => ({
    title: '  Test\nConversation  ',
    create_time: 1,
    update_time: 2,
    conversation_id: 'conv-1',
    current_node: 'assistant-2',
    mapping: {
        root: node('root', null, ['system'], null),
        system: node(
            'system',
            'root',
            ['user-1'],
            message('system', 'system', { content_type: 'text', parts: ['Hidden system prompt'] }),
        ),
        'user-1': node(
            'user-1',
            'system',
            ['reasoning'],
            message('user-1', 'user', { content_type: 'text', parts: ['First prompt'] }, { private: 'metadata' }),
        ),
        reasoning: node(
            'reasoning',
            'user-1',
            ['assistant-1'],
            message('reasoning', 'assistant', {
                content_type: 'thoughts',
                thoughts: [
                    {
                        summary: 'Private reasoning summary',
                        content: 'Private reasoning body',
                        chunks: ['Private reasoning chunk'],
                        finished: true,
                    },
                ],
            }),
        ),
        'assistant-1': node(
            'assistant-1',
            'reasoning',
            ['user-2'],
            message('assistant-1', 'assistant', { content_type: 'text', parts: ['First answer'] }),
        ),
        'user-2': node(
            'user-2',
            'assistant-1',
            ['tool', 'inactive-assistant'],
            message('user-2', 'user', { content_type: 'text', content: 'Second prompt' }),
        ),
        tool: node(
            'tool',
            'user-2',
            ['assistant-2'],
            message('tool', 'tool', { content_type: 'execution_output', content: 'Hidden tool output' }),
        ),
        'assistant-2': node(
            'assistant-2',
            'tool',
            [],
            message('assistant-2', 'assistant', {
                content_type: 'text',
                parts: ['Second answer\n\n```ts\nconst kept = true;\n```'],
            }),
        ),
        'inactive-assistant': node(
            'inactive-assistant',
            'user-2',
            [],
            message('inactive-assistant', 'assistant', {
                content_type: 'text',
                parts: ['Inactive branch answer'],
            }),
        ),
    },
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'gpt-5',
    safe_urls: [],
    blocked_urls: [],
});

describe('conversationToMarkdown', () => {
    it('should render only active-branch User and Assistant text messages', () => {
        expect(conversationToMarkdown(conversation())).toBe(`# Test Conversation

## User

First prompt

## Assistant

First answer

## User

Second prompt

## Assistant

Second answer

\`\`\`ts
const kept = true;
\`\`\`
`);
    });

    it('should exclude reasoning, system, tool, metadata, and inactive branch content', () => {
        const markdown = conversationToMarkdown(conversation());

        expect(markdown).not.toContain('Hidden system prompt');
        expect(markdown).not.toContain('Private reasoning');
        expect(markdown).not.toContain('Hidden tool output');
        expect(markdown).not.toContain('Inactive branch answer');
        expect(markdown).not.toContain('metadata');
    });

    it('should fail closed to a title-only document when current_node is invalid', () => {
        const data = conversation();
        data.current_node = 'missing';

        expect(conversationToMarkdown(data)).toBe('# Test Conversation\n');
    });
});
