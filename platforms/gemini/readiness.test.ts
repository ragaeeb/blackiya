import { beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('@/utils/logger', () => ({
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) },
}));

describe('Gemini — evaluateReadiness', () => {
    let geminiAdapter: any;

    beforeAll(async () => {
        const module = await import('@/platforms/gemini');
        geminiAdapter = module.geminiAdapter;
    });

    const baseConversationData = {
        title: 'Gemini Conversation',
        create_time: 1,
        update_time: 2,
        conversation_id: 'abc123',
        current_node: 'assistant-1',
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: 'gemini-pro',
        safe_urls: [],
        blocked_urls: [],
    };

    const makeMessage = (id: string, overrides: Record<string, any> = {}) => ({
        id,
        author: { role: 'assistant', name: 'Gemini', metadata: {} },
        create_time: 1,
        update_time: 2,
        content: { content_type: 'text', parts: [''] },
        status: 'finished_successfully',
        end_turn: true,
        weight: 1,
        metadata: {},
        recipient: 'all',
        channel: null,
        ...overrides,
    });

    it('should return not-ready when no assistant messages exist', () => {
        const readiness = geminiAdapter.evaluateReadiness?.({
            ...baseConversationData,
            mapping: {
                root: { id: 'root', message: null, parent: null, children: [] },
            },
        });
        expect(readiness?.ready).toBeFalse();
        expect(readiness?.reason).toBe('assistant-missing');
    });

    it('should return not-ready for thoughts-only assistant payloads (text is empty)', () => {
        const readiness = geminiAdapter.evaluateReadiness?.({
            ...baseConversationData,
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['assistant-1'] },
                'assistant-1': {
                    id: 'assistant-1',
                    parent: 'root',
                    children: [],
                    message: makeMessage('assistant-1', {
                        content: {
                            content_type: 'thoughts',
                            thoughts: [{ summary: 'Thinking', content: 'Draft', chunks: [], finished: true }],
                        },
                        end_turn: false,
                    }),
                },
            },
        });
        expect(readiness?.ready).toBeFalse();
        expect(readiness?.reason).toBe('assistant-text-missing');
    });

    it('should return not-ready when assistant is in_progress', () => {
        const readiness = geminiAdapter.evaluateReadiness?.({
            ...baseConversationData,
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['assistant-1'] },
                'assistant-1': {
                    id: 'assistant-1',
                    parent: 'root',
                    children: [],
                    message: makeMessage('assistant-1', {
                        status: 'in_progress',
                        content: { content_type: 'text', parts: ['Partial text'] },
                    }),
                },
            },
        });
        expect(readiness?.ready).toBeFalse();
        expect(readiness?.reason).toBe('assistant-in-progress');
    });

    it('should return not-ready when latest assistant turn is not terminal (end_turn false)', () => {
        const readiness = geminiAdapter.evaluateReadiness?.({
            ...baseConversationData,
            current_node: 'assistant-1',
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['assistant-1'] },
                'assistant-1': {
                    id: 'assistant-1',
                    parent: 'root',
                    children: [],
                    message: makeMessage('assistant-1', {
                        content: { content_type: 'text', parts: ['Partial text'] },
                        end_turn: false,
                    }),
                },
            },
        });
        expect(readiness?.ready).toBeFalse();
        expect(readiness?.reason).toBe('assistant-latest-text-not-terminal-turn');
    });

    it('should return ready for terminal assistant text payload', () => {
        const readiness = geminiAdapter.evaluateReadiness?.({
            ...baseConversationData,
            update_time: 3,
            current_node: 'assistant-2',
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['assistant-1'] },
                'assistant-1': {
                    id: 'assistant-1',
                    parent: 'root',
                    children: ['assistant-2'],
                    message: makeMessage('assistant-1', {
                        content: {
                            content_type: 'thoughts',
                            thoughts: [{ summary: 'Thinking', content: 'Draft', chunks: [], finished: true }],
                        },
                        end_turn: false,
                    }),
                },
                'assistant-2': {
                    id: 'assistant-2',
                    parent: 'assistant-1',
                    children: [],
                    message: makeMessage('assistant-2', {
                        update_time: 3,
                        content: { content_type: 'text', parts: ['Final answer'] },
                    }),
                },
            },
        });
        expect(readiness?.ready).toBeTrue();
        expect(readiness?.terminal).toBeTrue();
        expect(readiness?.contentHash).not.toBeNull();
    });
});
