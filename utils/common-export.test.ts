import { describe, expect, it } from 'bun:test';
import { buildCommonExport } from '@/utils/common-export';
import type { ConversationData } from '@/utils/types';

describe('buildCommonExport', () => {
    it('should build flat common export with prompt, response, and reasoning array from thoughts', () => {
        const conversation: ConversationData = {
            title: 'Thought Capture',
            create_time: 1_700_000_000,
            update_time: 1_700_000_100,
            conversation_id: 'conversation-123',
            current_node: 'assistant-final',
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['user'] },
                user: {
                    id: 'user',
                    message: {
                        id: 'user',
                        author: { role: 'user', name: 'User', metadata: {} },
                        create_time: 1_700_000_010,
                        update_time: 1_700_000_010,
                        content: { content_type: 'text', parts: ['Translate this.'] },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                    parent: 'root',
                    children: ['assistant-thoughts'],
                },
                'assistant-thoughts': {
                    id: 'assistant-thoughts',
                    message: {
                        id: 'assistant-thoughts',
                        author: { role: 'assistant', name: 'Assistant', metadata: {} },
                        create_time: 1_700_000_020,
                        update_time: 1_700_000_020,
                        content: {
                            content_type: 'thoughts',
                            thoughts: [
                                {
                                    summary: 'Plan A',
                                    content: 'First reasoning step.',
                                    chunks: [],
                                    finished: true,
                                },
                                {
                                    summary: 'Plan B',
                                    content: 'Second reasoning step.',
                                    chunks: [],
                                    finished: true,
                                },
                            ],
                        },
                        status: 'finished_successfully',
                        end_turn: false,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                    parent: 'user',
                    children: ['assistant-final'],
                },
                'assistant-final': {
                    id: 'assistant-final',
                    message: {
                        id: 'assistant-final',
                        author: { role: 'assistant', name: 'Assistant', metadata: {} },
                        create_time: 1_700_000_030,
                        update_time: 1_700_000_030,
                        content: { content_type: 'text', parts: ['Here is the translation.'] },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                    parent: 'assistant-thoughts',
                    children: [],
                },
            },
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'gpt-5',
            safe_urls: [],
            blocked_urls: [],
        };

        const result = buildCommonExport(conversation, 'ChatGPT');

        expect(result).toEqual({
            format: 'common',
            llm: 'ChatGPT',
            model: 'gpt-5',
            title: 'Thought Capture',
            conversation_id: 'conversation-123',
            created_at: new Date(1_700_000_000 * 1000).toISOString(),
            updated_at: new Date(1_700_000_100 * 1000).toISOString(),
            prompt: 'Translate this.',
            response: 'Here is the translation.',
            reasoning: ['First reasoning step.', 'Second reasoning step.'],
        });
    });

    it('should fall back to recap/metadata reasoning and metadata model', () => {
        const conversation: ConversationData = {
            title: 'Reasoning Recap',
            create_time: 1_700_010_000,
            update_time: 1_700_010_100,
            conversation_id: 'conversation-456',
            current_node: 'assistant',
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['user'] },
                user: {
                    id: 'user',
                    message: {
                        id: 'user',
                        author: { role: 'user', name: 'User', metadata: {} },
                        create_time: 1_700_010_010,
                        update_time: 1_700_010_010,
                        content: { content_type: 'text', parts: ['Explain this.'] },
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
                        metadata: { model: 'grok-2', reasoning: 'Metadata reasoning.' },
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
        expect(result.prompt).toBe('Explain this.');
        expect(result.response).toBe('Final answer.');
        expect(result.reasoning).toEqual(['Recap reasoning.', 'Metadata reasoning.']);
    });

    it('should export only the latest turn for multi-turn conversations', () => {
        const conversation: ConversationData = {
            title: 'Multi Turn',
            create_time: 1_700_020_000,
            update_time: 1_700_020_200,
            conversation_id: 'conversation-789',
            current_node: 'assistant-2',
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['user-1'] },
                'user-1': {
                    id: 'user-1',
                    message: {
                        id: 'user-1',
                        author: { role: 'user', name: 'User', metadata: {} },
                        create_time: 1_700_020_010,
                        update_time: 1_700_020_010,
                        content: { content_type: 'text', parts: ['First prompt'] },
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
                        content: { content_type: 'text', parts: ['First response'] },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: { reasoning: 'First reasoning.' },
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
                        content: { content_type: 'text', parts: ['Second prompt'] },
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
                        content: { content_type: 'text', parts: ['Second response'] },
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
            default_model_slug: 'gpt-5',
            safe_urls: [],
            blocked_urls: [],
        };

        const result = buildCommonExport(conversation, 'ChatGPT');

        expect(result.prompt).toBe('Second prompt');
        expect(result.response).toBe('Second response');
        expect(result.reasoning).toEqual(['Trace reasoning.']);
    });

    it('should prefer resolved_model_slug over default auto model', () => {
        const conversation: ConversationData = {
            title: 'Resolved Model',
            create_time: 1_700_030_000,
            update_time: 1_700_030_100,
            conversation_id: 'conversation-999',
            current_node: 'assistant',
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['user'] },
                user: {
                    id: 'user',
                    message: {
                        id: 'user',
                        author: { role: 'user', name: 'User', metadata: {} },
                        create_time: 1_700_030_010,
                        update_time: 1_700_030_010,
                        content: { content_type: 'text', parts: ['Model?'] },
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
                        create_time: 1_700_030_020,
                        update_time: 1_700_030_020,
                        content: { content_type: 'text', parts: ['Answer'] },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: { resolved_model_slug: 'gpt-5-t-mini', model_slug: 'gpt-5-t-mini' },
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
            default_model_slug: 'auto',
            safe_urls: [],
            blocked_urls: [],
        };

        const result = buildCommonExport(conversation, 'ChatGPT');
        expect(result.model).toBe('gpt-5-t-mini');
    });
});
