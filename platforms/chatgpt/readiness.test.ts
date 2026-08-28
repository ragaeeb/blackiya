/**
 * ChatGPT evaluateReadiness tests
 *
 * Verifies all readiness reason codes and terminal/ready flag combinations.
 */

import { beforeAll, describe, expect, it, mock } from 'bun:test';
import {
    deepResearchCompletedConversation,
    deepResearchInProgressConversation,
} from './fixtures/deep-research-conversation';
import { evaluateChatGPTReadiness } from './readiness';

mock.module('@/utils/logger', () => ({
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, setLevel: () => {} },
}));

const VALID_ID = '696bc3d5-fa84-8328-b209-4d65cb229e59';

const baseConversation = (mapping: any, overrides: any = {}) => ({
    title: 'Test',
    create_time: 1,
    update_time: 2,
    conversation_id: VALID_ID,
    current_node: Object.keys(mapping).at(-1) ?? 'root',
    mapping,
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'gpt-5',
    safe_urls: [],
    blocked_urls: [],
    ...overrides,
});

const assistantMessage = (id: string, overrides: any = {}) => ({
    id,
    author: { role: 'assistant', name: null, metadata: {} },
    create_time: 1,
    update_time: 2,
    content: { content_type: 'text', parts: ['hello'] },
    status: 'finished_successfully',
    end_turn: true,
    weight: 1,
    metadata: {},
    recipient: 'all',
    channel: null,
    ...overrides,
});

describe('ChatGPT evaluateReadiness', () => {
    let adapter: any;

    beforeAll(async () => {
        const module = await import('@/platforms/chatgpt');
        adapter = module.createChatGPTAdapter();
    });

    it('should fail closed when current_node does not reference the mapping', () => {
        const data = baseConversation(
            {
                root: { id: 'root', message: null, parent: null, children: ['a1'] },
                a1: {
                    id: 'a1',
                    parent: 'root',
                    children: [],
                    message: assistantMessage('a1'),
                },
            },
            { current_node: 'missing' },
        );

        const r = adapter.evaluateReadiness(data);

        expect(r.ready).toBeFalse();
        expect(r.reason).toBe('assistant-missing');
    });

    it('should return assistant-missing when mapping has no assistant messages', () => {
        const data = baseConversation({
            root: { id: 'root', message: null, parent: null, children: ['user-1'] },
            'user-1': {
                id: 'user-1',
                parent: 'root',
                children: [],
                message: {
                    id: 'user-1',
                    author: { role: 'user', name: null, metadata: {} },
                    create_time: 1,
                    update_time: 1,
                    content: { content_type: 'text', parts: ['Hi'] },
                    status: 'finished_successfully',
                    end_turn: true,
                    weight: 1,
                    metadata: {},
                    recipient: 'all',
                    channel: null,
                },
            },
        });
        const r = adapter.evaluateReadiness(data);
        expect(r.reason).toBe('assistant-missing');
        expect(r.ready).toBeFalse();
        expect(r.terminal).toBeFalse();
    });

    it('should reject a settled history whose active branch ends with a user message', () => {
        const data = baseConversation(
            {
                root: { id: 'root', message: null, parent: null, children: ['user-old'] },
                'user-old': {
                    id: 'user-old',
                    parent: 'root',
                    children: ['assistant-old'],
                    message: {
                        id: 'user-old',
                        author: { role: 'user', name: null, metadata: {} },
                        create_time: 1,
                        update_time: 1,
                        content: { content_type: 'text', parts: ['Earlier prompt'] },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                },
                'assistant-old': {
                    id: 'assistant-old',
                    parent: 'user-old',
                    children: ['user-interrupted'],
                    message: assistantMessage('assistant-old', {
                        content: { content_type: 'text', parts: ['Earlier answer'] },
                    }),
                },
                'user-interrupted': {
                    id: 'user-interrupted',
                    parent: 'assistant-old',
                    children: ['assistant-interrupted'],
                    message: {
                        id: 'user-interrupted',
                        author: { role: 'user', name: null, metadata: {} },
                        create_time: 2,
                        update_time: 2,
                        content: { content_type: 'text', parts: ['Interrupted prompt'] },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                },
                'assistant-interrupted': {
                    id: 'assistant-interrupted',
                    parent: 'user-interrupted',
                    children: ['user-latest'],
                    message: assistantMessage('assistant-interrupted', {
                        status: 'in_progress',
                        end_turn: false,
                        content: { content_type: 'thoughts', thoughts: [{ summary: 'Stopped thinking' }] },
                    }),
                },
                'user-latest': {
                    id: 'user-latest',
                    parent: 'assistant-interrupted',
                    children: [],
                    message: {
                        id: 'user-latest',
                        author: { role: 'user', name: null, metadata: {} },
                        create_time: 3,
                        update_time: 3,
                        content: { content_type: 'text', parts: ['Settled latest prompt'] },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                },
            },
            { current_node: 'user-latest' },
        );

        const r = adapter.evaluateReadiness(data);

        expect(r.ready).toBeFalse();
        expect(r.terminal).toBeFalse();
        expect(r.reason).toBe('assistant-missing');
    });

    it('should reject an interrupted assistant node without a terminal marker', () => {
        const data = baseConversation(
            {
                root: { id: 'root', message: null, parent: null, children: ['user-old'] },
                'user-old': {
                    id: 'user-old',
                    parent: 'root',
                    children: ['assistant-old'],
                    message: {
                        id: 'user-old',
                        author: { role: 'user', name: null, metadata: {} },
                        create_time: 1,
                        update_time: 1,
                        content: { content_type: 'text', parts: ['Earlier prompt'] },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                },
                'assistant-old': {
                    id: 'assistant-old',
                    parent: 'user-old',
                    children: ['user-latest'],
                    message: assistantMessage('assistant-old', {
                        content: { content_type: 'text', parts: ['Earlier answer'] },
                    }),
                },
                'user-latest': {
                    id: 'user-latest',
                    parent: 'assistant-old',
                    children: ['assistant-stopped'],
                    message: {
                        id: 'user-latest',
                        author: { role: 'user', name: null, metadata: {} },
                        create_time: 2,
                        update_time: 2,
                        content: { content_type: 'text', parts: ['Latest prompt'] },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                },
                'assistant-stopped': {
                    id: 'assistant-stopped',
                    parent: 'user-latest',
                    children: [],
                    message: assistantMessage('assistant-stopped', {
                        status: 'in_progress',
                        end_turn: false,
                        content: { content_type: 'thoughts', thoughts: [{ summary: 'Stopped thinking' }] },
                    }),
                },
            },
            { current_node: 'assistant-stopped' },
        );

        const readiness = evaluateChatGPTReadiness(data);

        expect(readiness.ready).toBeFalse();
        expect(readiness.terminal).toBeFalse();
        expect(readiness.reason).toBe('assistant-in-progress');
    });

    it('should accept a terminal reasoning recap with no assistant text', () => {
        const data = baseConversation(
            {
                root: { id: 'root', message: null, parent: null, children: ['user-1'] },
                'user-1': {
                    id: 'user-1',
                    parent: 'root',
                    children: ['assistant-recap'],
                    message: {
                        id: 'user-1',
                        author: { role: 'user', name: null, metadata: {} },
                        create_time: 1,
                        update_time: 1,
                        content: { content_type: 'text', parts: ['Please finish the memo'] },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                },
                'assistant-recap': {
                    id: 'assistant-recap',
                    parent: 'user-1',
                    children: [],
                    message: assistantMessage('assistant-recap', {
                        content: { content_type: 'reasoning_recap' },
                        end_turn: true,
                    }),
                },
            },
            { current_node: 'assistant-recap' },
        );

        const readiness = evaluateChatGPTReadiness(data);

        expect(readiness.ready).toBeTrue();
        expect(readiness.terminal).toBeTrue();
        expect(readiness.reason).toBe('terminal-marker');
        expect(readiness.contentHash).toBeString();
        expect(readiness.latestAssistantTextLength).toBe(1);
    });

    it('should accept an explicitly ended reasoning recap when end_turn is false', () => {
        const data = baseConversation(
            {
                root: { id: 'root', message: null, parent: null, children: ['user-1'] },
                'user-1': {
                    id: 'user-1',
                    parent: 'root',
                    children: ['assistant-recap'],
                    message: {
                        id: 'user-1',
                        author: { role: 'user', name: null, metadata: {} },
                        create_time: 1,
                        update_time: 1,
                        content: { content_type: 'text', parts: ['Please finish the memo'] },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                },
                'assistant-recap': {
                    id: 'assistant-recap',
                    parent: 'user-1',
                    children: [],
                    message: assistantMessage('assistant-recap', {
                        content: { content_type: 'reasoning_recap', content: 'hidden recap' },
                        end_turn: false,
                        metadata: {
                            reasoning_status: 'reasoning_ended',
                            can_save: false,
                        },
                    }),
                },
            },
            { current_node: 'assistant-recap' },
        );

        const readiness = evaluateChatGPTReadiness(data);

        expect(readiness.ready).toBeTrue();
        expect(readiness.terminal).toBeTrue();
        expect(readiness.reason).toBe('terminal-marker');
        expect(readiness.contentHash).toBeString();
        expect(readiness.latestAssistantTextLength).toBe(1);
    });

    it('should reject a reasoning recap whose reasoning has not ended', () => {
        const data = baseConversation({
            root: { id: 'root', message: null, parent: null, children: ['user-1'] },
            'user-1': {
                id: 'user-1',
                parent: 'root',
                children: ['assistant-recap'],
                message: {
                    id: 'user-1',
                    author: { role: 'user', name: null, metadata: {} },
                    create_time: 1,
                    update_time: 1,
                    content: { content_type: 'text', parts: ['Please finish the memo'] },
                    status: 'finished_successfully',
                    end_turn: true,
                    weight: 1,
                    metadata: {},
                    recipient: 'all',
                    channel: null,
                },
            },
            'assistant-recap': {
                id: 'assistant-recap',
                parent: 'user-1',
                children: [],
                message: assistantMessage('assistant-recap', {
                    content: { content_type: 'reasoning_recap', content: 'partial recap' },
                    end_turn: false,
                    metadata: { reasoning_status: 'is_reasoning' },
                }),
            },
        });

        const readiness = evaluateChatGPTReadiness(data);

        expect(readiness.ready).toBeFalse();
        expect(readiness.terminal).toBeFalse();
        expect(readiness.reason).toBe('assistant-text-missing');
    });

    it('should accept a finished terminal multimodal response with no assistant text', () => {
        const data = baseConversation(
            {
                root: { id: 'root', message: null, parent: null, children: ['user-1'] },
                'user-1': {
                    id: 'user-1',
                    parent: 'root',
                    children: ['assistant-image'],
                    message: {
                        id: 'user-1',
                        author: { role: 'user', name: null, metadata: {} },
                        create_time: 1,
                        update_time: 1,
                        content: { content_type: 'text', parts: ['Generate a logo'] },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                },
                'assistant-image': {
                    id: 'assistant-image',
                    parent: 'user-1',
                    children: [],
                    message: assistantMessage('assistant-image', {
                        content: {
                            content_type: 'multimodal_text',
                            parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-placeholder' }],
                        },
                        end_turn: true,
                    }),
                },
            },
            { current_node: 'assistant-image' },
        );

        const readiness = evaluateChatGPTReadiness(data);

        expect(readiness.ready).toBeTrue();
        expect(readiness.terminal).toBeTrue();
        expect(readiness.reason).toBe('terminal-marker');
        expect(readiness.contentHash).toBeString();
    });

    it('should accept a completed deep-research tool branch without final assistant text', () => {
        const readiness = evaluateChatGPTReadiness(deepResearchCompletedConversation);

        expect(readiness.ready).toBeTrue();
        expect(readiness.terminal).toBeTrue();
        expect(readiness.reason).toBe('terminal-marker');
        expect(readiness.contentHash).toBeString();
    });

    it('should not accept a deep-research tool branch while the tool is in progress', () => {
        const readiness = evaluateChatGPTReadiness(deepResearchInProgressConversation);

        expect(readiness.ready).toBeFalse();
        expect(readiness.terminal).toBeFalse();
    });

    it('should return assistant-in-progress when any assistant message is in_progress', () => {
        const data = baseConversation({
            root: { id: 'root', message: null, parent: null, children: ['a1'] },
            a1: {
                id: 'a1',
                parent: 'root',
                children: [],
                message: assistantMessage('a1', { status: 'in_progress', end_turn: false }),
            },
        });
        const r = adapter.evaluateReadiness(data);
        expect(r.reason).toBe('assistant-in-progress');
        expect(r.terminal).toBeFalse();
        expect(r.ready).toBeFalse();
    });

    it('should return assistant-text-missing for thoughts-only payloads (no finished text message)', () => {
        const data = baseConversation({
            root: { id: 'root', message: null, parent: null, children: ['a1'] },
            a1: {
                id: 'a1',
                parent: 'root',
                children: [],
                message: assistantMessage('a1', {
                    content: {
                        content_type: 'thoughts',
                        thoughts: [{ summary: 'Thinking', content: 'Draft', chunks: [], finished: true }],
                    },
                    end_turn: false,
                }),
            },
        });
        const r = adapter.evaluateReadiness(data);
        expect(r.ready).toBeFalse();
        expect(r.terminal).toBeFalse();
        expect(r.reason).toBe('assistant-text-missing');
    });

    it('should return assistant-text-missing when only assistant message has error status', () => {
        const data = baseConversation({
            root: { id: 'root', message: null, parent: null, children: ['a1'] },
            a1: {
                id: 'a1',
                parent: 'root',
                children: [],
                message: assistantMessage('a1', { status: 'error' }),
            },
        });
        const r = adapter.evaluateReadiness(data);
        expect(r.reason).toBe('assistant-text-missing');
        expect(r.terminal).toBeFalse();
    });

    it('should accept a finished latest text message without relying on end_turn', () => {
        const data = baseConversation({
            root: { id: 'root', message: null, parent: null, children: ['a1'] },
            a1: {
                id: 'a1',
                parent: 'root',
                children: ['a2'],
                message: assistantMessage('a1', { create_time: 1, update_time: 1 }),
            },
            a2: {
                id: 'a2',
                parent: 'a1',
                children: [],
                message: assistantMessage('a2', {
                    create_time: 2,
                    update_time: 2,
                    end_turn: false,
                    content: { content_type: 'text', parts: ['Latest still not terminal'] },
                }),
            },
        });
        const r = adapter.evaluateReadiness(data);
        expect(r.ready).toBeTrue();
        expect(r.terminal).toBeTrue();
        expect(r.reason).toBe('terminal');
    });

    it('should return ready/terminal for a finished text message with end_turn true', () => {
        const data = baseConversation({
            root: { id: 'root', message: null, parent: null, children: ['a1'] },
            a1: {
                id: 'a1',
                parent: 'root',
                children: [],
                message: assistantMessage('a1', { content: { content_type: 'text', parts: ['Final answer'] } }),
            },
        });
        const r = adapter.evaluateReadiness(data);
        expect(r.ready).toBeTrue();
        expect(r.terminal).toBeTrue();
        expect(r.reason).toBe('terminal');
        expect(typeof r.contentHash).toBe('string');
        expect(r.latestAssistantTextLength).toBeGreaterThan(0);
    });

    it('should be ready when the latest text turn is terminal even when an older thoughts message exists', () => {
        const data = baseConversation({
            root: { id: 'root', message: null, parent: null, children: ['a1'] },
            a1: {
                id: 'a1',
                parent: 'root',
                children: ['a2'],
                message: assistantMessage('a1', {
                    create_time: 1,
                    update_time: 1,
                    end_turn: false,
                    content: {
                        content_type: 'thoughts',
                        thoughts: [{ summary: 'Thinking', content: 'Draft', chunks: [], finished: true }],
                    },
                }),
            },
            a2: {
                id: 'a2',
                parent: 'a1',
                children: [],
                message: assistantMessage('a2', {
                    create_time: 2,
                    update_time: 2,
                    content: { content_type: 'text', parts: ['Final answer'] },
                }),
            },
        });
        const r = adapter.evaluateReadiness(data);
        expect(r.ready).toBeTrue();
        expect(r.reason).toBe('terminal');
        expect(r.contentHash).not.toBeNull();
    });

    it('should ignore an in-progress assistant message on an inactive branch', () => {
        const data = baseConversation(
            {
                root: { id: 'root', message: null, parent: null, children: ['active-final', 'inactive-progress'] },
                'active-final': {
                    id: 'active-final',
                    parent: 'root',
                    children: [],
                    message: assistantMessage('active-final', {
                        create_time: 2,
                        update_time: 2,
                        content: { content_type: 'text', parts: ['Active branch final answer'] },
                    }),
                },
                'inactive-progress': {
                    id: 'inactive-progress',
                    parent: 'root',
                    children: [],
                    message: assistantMessage('inactive-progress', {
                        create_time: 3,
                        update_time: 3,
                        status: 'in_progress',
                        end_turn: false,
                        content: { content_type: 'text', parts: ['Abandoned branch'] },
                    }),
                },
            },
            { current_node: 'active-final' },
        );

        const r = adapter.evaluateReadiness(data);

        expect(r.ready).toBeTrue();
        expect(r.terminal).toBeTrue();
        expect(r.reason).toBe('terminal');
        expect(r.latestAssistantTextLength).toBe('Active branch final answer'.length);
    });

    it('should remain blocked when the active branch assistant message is in progress', () => {
        const data = baseConversation(
            {
                root: { id: 'root', message: null, parent: null, children: ['finished-sibling', 'active-progress'] },
                'finished-sibling': {
                    id: 'finished-sibling',
                    parent: 'root',
                    children: [],
                    message: assistantMessage('finished-sibling'),
                },
                'active-progress': {
                    id: 'active-progress',
                    parent: 'root',
                    children: [],
                    message: assistantMessage('active-progress', {
                        status: 'in_progress',
                        end_turn: false,
                    }),
                },
            },
            { current_node: 'active-progress' },
        );

        const r = adapter.evaluateReadiness(data);

        expect(r.ready).toBeFalse();
        expect(r.terminal).toBeFalse();
        expect(r.reason).toBe('assistant-in-progress');
    });

    it('should ignore an unfinished assistant message from an earlier turn on the active branch', () => {
        const data = baseConversation(
            {
                root: { id: 'root', message: null, parent: null, children: ['user-old'] },
                'user-old': {
                    id: 'user-old',
                    parent: 'root',
                    children: ['assistant-old'],
                    message: {
                        ...assistantMessage('user-old'),
                        author: { role: 'user', name: null, metadata: {} },
                        content: { content_type: 'text', parts: ['Old prompt'] },
                    },
                },
                'assistant-old': {
                    id: 'assistant-old',
                    parent: 'user-old',
                    children: ['user-latest'],
                    message: assistantMessage('assistant-old', {
                        status: 'in_progress',
                        end_turn: false,
                        content: { content_type: 'text', parts: ['Abandoned old response'] },
                    }),
                },
                'user-latest': {
                    id: 'user-latest',
                    parent: 'assistant-old',
                    children: ['assistant-latest'],
                    message: {
                        ...assistantMessage('user-latest'),
                        author: { role: 'user', name: null, metadata: {} },
                        content: { content_type: 'text', parts: ['Latest prompt'] },
                    },
                },
                'assistant-latest': {
                    id: 'assistant-latest',
                    parent: 'user-latest',
                    children: [],
                    message: assistantMessage('assistant-latest', {
                        content: { content_type: 'text', parts: ['Latest final answer'] },
                    }),
                },
            },
            { current_node: 'assistant-latest' },
        );

        const r = adapter.evaluateReadiness(data);

        expect(r.ready).toBeTrue();
        expect(r.terminal).toBeTrue();
        expect(r.reason).toBe('terminal');
        expect(r.latestAssistantTextLength).toBe('Latest final answer'.length);
    });

    it('should ignore an in-progress reasoning node followed by finished text in the same turn', () => {
        const data = baseConversation(
            {
                root: { id: 'root', message: null, parent: null, children: ['user-latest'] },
                'user-latest': {
                    id: 'user-latest',
                    parent: 'root',
                    children: ['assistant-reasoning'],
                    message: {
                        ...assistantMessage('user-latest'),
                        author: { role: 'user', name: null, metadata: {} },
                        content: { content_type: 'text', parts: ['Latest prompt'] },
                    },
                },
                'assistant-reasoning': {
                    id: 'assistant-reasoning',
                    parent: 'user-latest',
                    children: ['assistant-final'],
                    message: assistantMessage('assistant-reasoning', {
                        status: 'in_progress',
                        end_turn: false,
                        content: {
                            content_type: 'thoughts',
                            thoughts: [{ summary: 'Reasoning', content: 'Draft', chunks: [], finished: true }],
                        },
                    }),
                },
                'assistant-final': {
                    id: 'assistant-final',
                    parent: 'assistant-reasoning',
                    children: [],
                    message: assistantMessage('assistant-final', {
                        content: { content_type: 'text', parts: ['Finished answer'] },
                    }),
                },
            },
            { current_node: 'assistant-final' },
        );

        const r = adapter.evaluateReadiness(data);

        expect(r.ready).toBeTrue();
        expect(r.reason).toBe('terminal');
        expect(r.latestAssistantTextLength).toBe('Finished answer'.length);
    });

    it('should remain blocked when an in-progress assistant node follows finished text', () => {
        const data = baseConversation(
            {
                root: { id: 'root', message: null, parent: null, children: ['assistant-text'] },
                'assistant-text': {
                    id: 'assistant-text',
                    parent: 'root',
                    children: ['assistant-progress'],
                    message: assistantMessage('assistant-text', {
                        content: { content_type: 'text', parts: ['Earlier answer'] },
                    }),
                },
                'assistant-progress': {
                    id: 'assistant-progress',
                    parent: 'assistant-text',
                    children: [],
                    message: assistantMessage('assistant-progress', {
                        status: 'in_progress',
                        end_turn: false,
                        content: { content_type: 'thoughts' },
                    }),
                },
            },
            { current_node: 'assistant-progress' },
        );

        const r = adapter.evaluateReadiness(data);

        expect(r.ready).toBeFalse();
        expect(r.terminal).toBeFalse();
        expect(r.reason).toBe('assistant-in-progress');
    });
});
