import { beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('wxt/browser', () => ({
    browser: {
        storage: { local: { get: async () => ({}), set: async () => {} } },
        runtime: { getURL: () => 'chrome-extension://mock/' },
    },
}));
mock.module('@/utils/logger', () => ({
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

let grokAdapter: any;

beforeAll(async () => {
    const mod = await import('@/platforms/grok');
    grokAdapter = mod.grokAdapter;
});

const baseData = {
    title: 'Grok Conversation',
    create_time: 1,
    update_time: 2,
    conversation_id: '2013295304527827227',
    current_node: 'assistant-1',
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'grok-4',
    safe_urls: [],
    blocked_urls: [],
};

const makeAssistantNode = (id: string, overrides: Record<string, any> = {}) => ({
    id,
    parent: 'root',
    children: [],
    message: {
        id,
        author: { role: 'assistant', name: 'Grok', metadata: {} },
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
    },
});

describe('Grok Adapter — evaluateReadiness', () => {
    it('should return not-ready when there are no assistant messages', () => {
        const readiness = grokAdapter.evaluateReadiness?.({
            ...baseData,
            mapping: { root: { id: 'root', message: null, parent: null, children: [] } },
        });
        expect(readiness?.ready).toBeFalse();
        expect(readiness?.reason).toBe('assistant-missing');
    });

    it('should return not-ready for in_progress assistant messages', () => {
        const readiness = grokAdapter.evaluateReadiness?.({
            ...baseData,
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['assistant-1'] },
                'assistant-1': makeAssistantNode('assistant-1', {
                    content: { content_type: 'text', parts: ['Partial text'] },
                    status: 'in_progress',
                    end_turn: false,
                }),
            },
        });
        expect(readiness?.ready).toBeFalse();
        expect(readiness?.terminal).toBeFalse();
        expect(readiness?.reason).toBe('assistant-in-progress');
    });

    it('should return not-ready when latest assistant text is empty', () => {
        const readiness = grokAdapter.evaluateReadiness?.({
            ...baseData,
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['assistant-1'] },
                'assistant-1': makeAssistantNode('assistant-1', {
                    content: { content_type: 'text', parts: [''] },
                }),
            },
        });
        expect(readiness?.ready).toBeFalse();
        expect(readiness?.reason).toBe('assistant-text-missing');
    });

    it('should return not-ready when latest turn has end_turn false', () => {
        const readiness = grokAdapter.evaluateReadiness?.({
            ...baseData,
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['assistant-1'] },
                'assistant-1': makeAssistantNode('assistant-1', {
                    content: { content_type: 'text', parts: ['Partial text'] },
                    end_turn: false,
                }),
            },
        });
        expect(readiness?.ready).toBeFalse();
        expect(readiness?.reason).toBe('assistant-latest-text-not-terminal-turn');
    });

    it('should return ready for a finished terminal assistant response', () => {
        const readiness = grokAdapter.evaluateReadiness?.({
            ...baseData,
            update_time: 3,
            current_node: 'assistant-2',
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['assistant-2'] },
                'assistant-2': makeAssistantNode('assistant-2', {
                    update_time: 3,
                    content: { content_type: 'text', parts: ['Final answer'] },
                }),
            },
        });
        expect(readiness?.ready).toBeTrue();
        expect(readiness?.terminal).toBeTrue();
        expect(readiness?.contentHash).not.toBeNull();
    });
});
