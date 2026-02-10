import { describe, expect, it } from 'bun:test';
import { buildCommonExport } from '@/utils/common-export';
import type { ConversationData } from '@/utils/types';

describe('buildCommonExport', () => {
    it('should build a normalized export with prompt, response, and reasoning', () => {
        const assistantTimestamp = 1_700_000_050;

        const conversation: ConversationData = {
            title: 'Test Conversation',
            create_time: 1_700_000_000,
            update_time: 1_700_000_100,
            conversation_id: 'conversation-123',
            current_node: 'node-2',
            mapping: {
                root: {
                    id: 'root',
                    message: null,
                    parent: null,
                    children: ['node-1'],
                },
                'node-1': {
                    id: 'node-1',
                    message: {
                        id: 'node-1',
                        author: { role: 'user', name: 'User', metadata: {} },
                        create_time: 1_700_000_010,
                        update_time: 1_700_000_010,
                        content: {
                            content_type: 'text',
                            parts: ['Hello?'],
                        },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                    parent: 'root',
                    children: ['node-2'],
                },
                'node-2': {
                    id: 'node-2',
                    message: {
                        id: 'node-2',
                        author: { role: 'assistant', name: 'Assistant', metadata: {} },
                        create_time: assistantTimestamp,
                        update_time: assistantTimestamp,
                        content: {
                            content_type: 'thoughts',
                            parts: ['Hi there!'],
                            thoughts: [
                                {
                                    summary: 'Reason',
                                    content: 'Reasoning text.',
                                    chunks: [],
                                    finished: true,
                                },
                            ],
                        },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                    parent: 'node-1',
                    children: [],
                },
            },
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'gpt-4o',
            safe_urls: [],
            blocked_urls: [],
        };

        const result = buildCommonExport(conversation, 'ChatGPT');

        expect(result.format).toBe('common');
        expect(result.llm).toBe('ChatGPT');
        expect(result.model).toBe('gpt-4o');
        expect(result.turns.length).toBe(1);
        expect(result.turns[0]).toEqual({
            prompt: 'Hello?',
            response: 'Hi there!',
            reasoning: 'Reasoning text.',
            timestamp: new Date(assistantTimestamp * 1000).toISOString(),
        });
    });

    it('should fall back to assistant metadata model and reasoning_recap content', () => {
        const conversation: ConversationData = {
            title: 'Reasoning Recap',
            create_time: 1_700_010_000,
            update_time: 1_700_010_100,
            conversation_id: 'conversation-456',
            current_node: 'assistant',
            mapping: {
                root: {
                    id: 'root',
                    message: null,
                    parent: null,
                    children: ['user'],
                },
                user: {
                    id: 'user',
                    message: {
                        id: 'user',
                        author: { role: 'user', name: 'User', metadata: {} },
                        create_time: 1_700_010_010,
                        update_time: 1_700_010_010,
                        content: {
                            content_type: 'text',
                            parts: ['Explain this.'],
                        },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                    parent: 'root',
                    children: ['assistant'],
                },
                assistant: {
                    id: 'assistant',
                    message: {
                        id: 'assistant',
                        author: { role: 'assistant', name: 'Assistant', metadata: {} },
                        create_time: 1_700_010_020,
                        update_time: 1_700_010_020,
                        content: {
                            content_type: 'reasoning_recap',
                            content: 'Recap reasoning.',
                            parts: ['Final answer.'],
                        },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: { model: 'grok-2' },
                        recipient: 'all',
                        channel: null,
                    },
                    parent: 'user',
                    children: [],
                },
            },
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: '',
            safe_urls: [],
            blocked_urls: [],
        };

        const result = buildCommonExport(conversation, 'Grok');

        expect(result.model).toBe('grok-2');
        expect(result.turns[0]).toEqual({
            prompt: 'Explain this.',
            response: 'Final answer.',
            reasoning: 'Recap reasoning.',
            timestamp: new Date(1_700_010_020 * 1000).toISOString(),
        });
    });

    it('should extract reasoning from metadata and handle multiple turns', () => {
        const conversation: ConversationData = {
            title: 'Multi Turn',
            create_time: 1_700_020_000,
            update_time: 1_700_020_200,
            conversation_id: 'conversation-789',
            current_node: 'assistant-2',
            mapping: {
                root: {
                    id: 'root',
                    message: null,
                    parent: null,
                    children: ['user-1'],
                },
                'user-1': {
                    id: 'user-1',
                    message: {
                        id: 'user-1',
                        author: { role: 'user', name: 'User', metadata: {} },
                        create_time: 1_700_020_010,
                        update_time: 1_700_020_010,
                        content: {
                            content_type: 'text',
                            parts: ['First prompt'],
                        },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                    parent: 'root',
                    children: ['assistant-1'],
                },
                'assistant-1': {
                    id: 'assistant-1',
                    message: {
                        id: 'assistant-1',
                        author: { role: 'assistant', name: 'Assistant', metadata: {} },
                        create_time: 1_700_020_020,
                        update_time: 1_700_020_020,
                        content: {
                            content_type: 'text',
                            parts: ['First response'],
                        },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: { reasoning: 'Metadata reasoning.' },
                        recipient: 'all',
                        channel: null,
                    },
                    parent: 'user-1',
                    children: ['user-2'],
                },
                'user-2': {
                    id: 'user-2',
                    message: {
                        id: 'user-2',
                        author: { role: 'user', name: 'User', metadata: {} },
                        create_time: 1_700_020_030,
                        update_time: 1_700_020_030,
                        content: {
                            content_type: 'text',
                            parts: ['Second prompt'],
                        },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                    parent: 'assistant-1',
                    children: ['assistant-2'],
                },
                'assistant-2': {
                    id: 'assistant-2',
                    message: {
                        id: 'assistant-2',
                        author: { role: 'assistant', name: 'Assistant', metadata: {} },
                        create_time: 1_700_020_040,
                        update_time: 1_700_020_040,
                        content: {
                            content_type: 'text',
                            parts: ['Second response'],
                        },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: { thinking_trace: 'Trace reasoning.' },
                        recipient: 'all',
                        channel: null,
                    },
                    parent: 'user-2',
                    children: [],
                },
            },
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'gpt-4o-mini',
            safe_urls: [],
            blocked_urls: [],
        };

        const result = buildCommonExport(conversation, 'ChatGPT');

        expect(result.turns.length).toBe(2);
        expect(result.turns[0].prompt).toBe('First prompt');
        expect(result.turns[0].response).toBe('First response');
        expect(result.turns[0].reasoning).toBe('Metadata reasoning.');
        expect(result.turns[1].prompt).toBe('Second prompt');
        expect(result.turns[1].response).toBe('Second response');
        expect(result.turns[1].reasoning).toBe('Trace reasoning.');
    });
});
