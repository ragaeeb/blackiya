/**
 * ChatGPT evaluateReadiness tests
 *
 * Verifies all readiness reason codes and terminal/ready flag combinations.
 */

import { beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('@/utils/logger', () => ({
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, setLevel: () => {} },
}));

const VALID_ID = '696bc3d5-fa84-8328-b209-4d65cb229e59';

const baseConversation = (mapping: any, overrides: any = {}) => ({
    title: 'Test',
    create_time: 1,
    update_time: 2,
    conversation_id: VALID_ID,
    current_node: 'assistant',
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
        expect(r.terminal).toBeTrue();
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
        expect(r.terminal).toBeTrue();
    });

    it('should return assistant-latest-text-not-terminal-turn when latest text message has end_turn false', () => {
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
        expect(r.ready).toBeFalse();
        expect(r.terminal).toBeTrue();
        expect(r.reason).toBe('assistant-latest-text-not-terminal-turn');
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
});
