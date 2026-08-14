/**
 * ChatGPT adapter configuration tests
 *
 * Covers: apiEndpointPattern, completionTriggerPattern,
 * getButtonInjectionTarget, isPlatformGenerating,
 * and guards against removed DOM-title-fallback fields.
 */

import { beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('@/utils/logger', () => ({
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, setLevel: () => {} },
}));

const ID = '696bc3d5-fa84-8328-b209-4d65cb229e59';

const interruptedConversation = () => ({
    title: 'Interrupted',
    create_time: 1,
    update_time: 2,
    conversation_id: ID,
    current_node: 'assistant-stopped',
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'gpt-5',
    safe_urls: [],
    blocked_urls: [],
    mapping: {
        root: { id: 'root', message: null, parent: null, children: ['user-1'] },
        'user-1': {
            id: 'user-1',
            parent: 'root',
            children: ['assistant-stopped'],
            message: {
                id: 'user-1',
                author: { role: 'user', name: null, metadata: {} },
                create_time: 1,
                update_time: 1,
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
            parent: 'user-1',
            children: [],
            message: {
                id: 'assistant-stopped',
                author: { role: 'assistant', name: null, metadata: {} },
                create_time: 2,
                update_time: 2,
                content: { content_type: 'thoughts', thoughts: [{ summary: 'Stopped thinking' }] },
                status: 'in_progress',
                end_turn: false,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        },
    },
});

describe('ChatGPT adapter configuration', () => {
    let adapter: any;

    beforeAll(async () => {
        const module = await import('@/platforms/chatgpt');
        adapter = module.createChatGPTAdapter();
    });

    describe('apiEndpointPattern', () => {
        it('should match backend-api/conversation/{uuid}', () => {
            expect(adapter.apiEndpointPattern.test(`https://chatgpt.com/backend-api/conversation/${ID}`)).toBeTrue();
        });

        it('should match backend-api/conversation/{uuid} with query params', () => {
            expect(
                adapter.apiEndpointPattern.test(`https://chatgpt.com/backend-api/conversation/${ID}?foo=bar`),
            ).toBeTrue();
        });

        it('should match backend-api/f/conversation', () => {
            expect(adapter.apiEndpointPattern.test('https://chatgpt.com/backend-api/f/conversation')).toBeTrue();
        });

        it('should not match unrelated API paths', () => {
            expect(adapter.apiEndpointPattern.test('https://chatgpt.com/backend-api/models')).toBeFalse();
        });
    });

    describe('completionTriggerPattern', () => {
        it('should match stream_status endpoint', () => {
            expect(
                adapter.completionTriggerPattern.test(
                    `https://chatgpt.com/backend-api/conversation/${ID}/stream_status`,
                ),
            ).toBeTrue();
        });

        it('should not match textdocs endpoint', () => {
            expect(
                adapter.completionTriggerPattern.test(`https://chatgpt.com/backend-api/conversation/${ID}/textdocs`),
            ).toBeFalse();
        });
    });

    describe('no DOM title fallback (V2.1-036 guard)', () => {
        it('should NOT expose extractTitleFromDom (ChatGPT uses SSE title resolution)', () => {
            expect(adapter.extractTitleFromDom).toBeUndefined();
        });

        it('should NOT expose defaultTitles (ChatGPT uses SSE title resolution)', () => {
            expect(adapter.defaultTitles).toBeUndefined();
        });
    });

    describe('getButtonInjectionTarget', () => {
        it('should return parent element when selector matches', () => {
            const parent = { id: 'parent' };
            const originalDocument = (globalThis as any).document;
            (globalThis as any).document = {
                querySelector: (sel: string) =>
                    sel === '[data-testid="model-switcher-dropdown-button"]' ? { parentElement: parent } : null,
            };
            try {
                expect(adapter.getButtonInjectionTarget()).toBe(parent);
            } finally {
                (globalThis as any).document = originalDocument;
            }
        });

        it('should return null when no selector matches', () => {
            const originalDocument = (globalThis as any).document;
            (globalThis as any).document = { querySelector: () => null };
            try {
                expect(adapter.getButtonInjectionTarget()).toBeNull();
            } finally {
                (globalThis as any).document = originalDocument;
            }
        });
    });

    describe('interrupted response readiness', () => {
        it('accepts an interrupted response before conversation turns render when no generation is active', () => {
            const originalDocument = (globalThis as any).document;
            (globalThis as any).document = { querySelector: () => null };
            try {
                const readiness = adapter.evaluateReadiness(interruptedConversation());
                expect(readiness.ready).toBeTrue();
                expect(readiness.reason).toBe('terminal-interrupted');
            } finally {
                (globalThis as any).document = originalDocument;
            }
        });

        it('accepts an interrupted response when the rendered thread is no longer generating', () => {
            const originalDocument = (globalThis as any).document;
            (globalThis as any).document = {
                querySelector: (selector: string) => (selector === '[data-testid^="conversation-turn-"]' ? {} : null),
            };
            try {
                const readiness = adapter.evaluateReadiness(interruptedConversation());
                expect(readiness.ready).toBeTrue();
                expect(readiness.reason).toBe('terminal-interrupted');
            } finally {
                (globalThis as any).document = originalDocument;
            }
        });

        it('accepts a terminal reasoning recap even while a stale stop control is present', () => {
            const originalDocument = (globalThis as any).document;
            const conversation = interruptedConversation() as any;
            conversation.mapping['assistant-stopped'].message = {
                ...conversation.mapping['assistant-stopped'].message,
                status: 'finished_successfully',
                end_turn: true,
                content: { content_type: 'reasoning_recap' },
            };
            (globalThis as any).document = {
                querySelector: (selector: string) => (selector.includes('stop-button') ? {} : null),
            };
            try {
                const readiness = adapter.evaluateReadiness(conversation);
                expect(readiness.ready).toBeTrue();
                expect(readiness.reason).toBe('terminal-interrupted');
            } finally {
                (globalThis as any).document = originalDocument;
            }
        });

        it('keeps an interrupted response blocked while a stop control is present', () => {
            const originalDocument = (globalThis as any).document;
            (globalThis as any).document = {
                querySelector: (selector: string) =>
                    selector === '[data-testid^="conversation-turn-"]' || selector.includes('stop-button') ? {} : null,
            };
            try {
                const readiness = adapter.evaluateReadiness(interruptedConversation());
                expect(readiness.ready).toBeFalse();
                expect(readiness.reason).toBe('assistant-in-progress');
            } finally {
                (globalThis as any).document = originalDocument;
            }
        });
    });
});
