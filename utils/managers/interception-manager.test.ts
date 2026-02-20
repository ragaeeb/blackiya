import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { getSessionToken, setSessionToken } from '@/utils/protocol/session-token';

mock.module('wxt/browser', () => ({
    browser: {
        storage: {
            onChanged: {
                addListener: () => {},
            },
            local: {
                get: async () => ({}),
            },
        },
        runtime: {
            sendMessage: async () => {},
        },
    },
}));

const loggerSpies = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
};

// Mock logger to avoid wxt/browser dependency in tests
mock.module('@/utils/logger', () => ({
    logger: loggerSpies,
}));

import { InterceptionManager } from './interception-manager';

describe('InterceptionManager', () => {
    const windowInstance = new Window();
    const document = windowInstance.document;

    beforeEach(() => {
        loggerSpies.info.mockClear();
        loggerSpies.warn.mockClear();
        loggerSpies.error.mockClear();
        loggerSpies.debug.mockClear();

        (global as any).window = windowInstance;
        (global as any).document = document;
        (globalThis as any).window = windowInstance;
        (global as any).alert = () => {};

        windowInstance.location.href = 'https://chatgpt.com/c/123';
        setSessionToken('bk:test-interception-token');
        (global as any).window.__BLACKIYA_CAPTURE_QUEUE__ = [];
        (global as any).window.__BLACKIYA_LOG_QUEUE__ = [];
    });

    it('should process queued intercepted messages on start', async () => {
        const captured: string[] = [];
        const globalRef = {} as any;
        const manager = new InterceptionManager((id) => captured.push(id), {
            window: windowInstance as any,
            global: globalRef,
        });

        const adapter = {
            parseInterceptedData: () => ({
                title: 'Test',
                create_time: 1,
                update_time: 2,
                mapping: {},
                conversation_id: '123',
                current_node: 'node-1',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gpt-4',
                safe_urls: [],
                blocked_urls: [],
            }),
        };

        manager.updateAdapter(adapter as any);

        globalRef.__BLACKIYA_CAPTURE_QUEUE__ = [
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: '{}',
                __blackiyaToken: getSessionToken(),
            },
        ];

        manager.flushQueuedMessages();

        expect(captured).toEqual(['123']);
        expect(manager.getConversation('123')).toBeDefined();
        expect(globalRef.__BLACKIYA_CAPTURE_QUEUE__).toEqual([]);
    });

    it('should flush queued interceptor log messages on start', async () => {
        const manager = new InterceptionManager(() => {}, {
            window: windowInstance as any,
            global: globalThis,
        });

        (globalThis as any).__BLACKIYA_LOG_QUEUE__ = [
            {
                type: 'LLM_LOG_ENTRY',
                payload: {
                    level: 'info',
                    message: 'API match ChatGPT',
                    data: [],
                    context: 'interceptor',
                },
                __blackiyaToken: getSessionToken(),
            },
        ];

        manager.start();

        expect(loggerSpies.info).toHaveBeenCalledWith('[i] API match ChatGPT');
        expect((globalThis as any).__BLACKIYA_LOG_QUEUE__).toEqual([]);

        manager.stop();
    });

    it('should continue processing queued capture messages when one queued message throws', () => {
        const captured: string[] = [];
        const globalRef = {} as any;
        const manager = new InterceptionManager((id) => captured.push(id), {
            window: windowInstance as any,
            global: globalRef,
        });

        const adapter = {
            parseInterceptedData: (raw: string) => JSON.parse(raw),
        };
        manager.updateAdapter(adapter as any);

        globalRef.__BLACKIYA_CAPTURE_QUEUE__ = [
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://chatgpt.com/backend-api/conversation/one',
                data: JSON.stringify({
                    conversation_id: 'one',
                    mapping: {},
                    title: 'One',
                    create_time: 1,
                    update_time: 1,
                    current_node: 'n1',
                    moderation_results: [],
                    plugin_ids: null,
                    gizmo_id: null,
                    gizmo_type: null,
                    is_archived: false,
                    default_model_slug: 'x',
                    safe_urls: [],
                    blocked_urls: [],
                }),
                __blackiyaToken: getSessionToken(),
            },
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://chatgpt.com/backend-api/conversation/two',
                data: JSON.stringify({ conversation_id: 'two', mapping: {} }),
                __blackiyaToken: getSessionToken(),
            },
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://chatgpt.com/backend-api/conversation/three',
                data: JSON.stringify({
                    conversation_id: 'three',
                    mapping: {},
                    title: 'Three',
                    create_time: 1,
                    update_time: 1,
                    current_node: 'n1',
                    moderation_results: [],
                    plugin_ids: null,
                    gizmo_id: null,
                    gizmo_type: null,
                    is_archived: false,
                    default_model_slug: 'x',
                    safe_urls: [],
                    blocked_urls: [],
                }),
                __blackiyaToken: getSessionToken(),
            },
        ];

        let calls = 0;
        const managerAny = manager as any;
        const originalHandleInterceptedData = managerAny.handleInterceptedData.bind(managerAny);
        managerAny.handleInterceptedData = (message: any) => {
            calls += 1;
            if (calls === 2) {
                throw new Error('boom');
            }
            originalHandleInterceptedData(message);
        };

        expect(() => manager.flushQueuedMessages()).not.toThrow();
        expect(captured).toEqual(['one', 'three']);
        expect(globalRef.__BLACKIYA_CAPTURE_QUEUE__).toEqual([]);

        manager.flushQueuedMessages();
        expect(captured).toEqual(['one', 'three']);
    });

    it('should continue processing queued log messages when one queued log throws', () => {
        const globalRef = {} as any;
        const manager = new InterceptionManager(() => {}, {
            window: windowInstance as any,
            global: globalRef,
        });

        globalRef.__BLACKIYA_LOG_QUEUE__ = [
            {
                type: 'LLM_LOG_ENTRY',
                payload: { level: 'info', message: 'first', data: [], context: 'interceptor' },
                __blackiyaToken: getSessionToken(),
            },
            {
                type: 'LLM_LOG_ENTRY',
                payload: { level: 'info', message: 'second', data: [], context: 'interceptor' },
                __blackiyaToken: getSessionToken(),
            },
            {
                type: 'LLM_LOG_ENTRY',
                payload: { level: 'info', message: 'third', data: [], context: 'interceptor' },
                __blackiyaToken: getSessionToken(),
            },
        ];

        const handled: string[] = [];
        const managerAny = manager as any;
        managerAny.handleLogEntry = (payload: any) => {
            handled.push(payload?.message ?? 'unknown');
            if (payload?.message === 'second') {
                throw new Error('log boom');
            }
        };

        expect(() => managerAny.processQueuedLogMessages()).not.toThrow();
        expect(handled).toEqual(['first', 'second', 'third']);
        expect(globalRef.__BLACKIYA_LOG_QUEUE__).toEqual([]);

        managerAny.processQueuedLogMessages();
        expect(handled).toEqual(['first', 'second', 'third']);
    });

    it('should revalidate queued messages with missing token once session token is available', () => {
        const captured: string[] = [];
        const globalRef = {} as any;
        const manager = new InterceptionManager((id) => captured.push(id), {
            window: windowInstance as any,
            global: globalRef,
        });

        manager.updateAdapter({
            parseInterceptedData: () => ({
                title: 'Queued',
                create_time: 1,
                update_time: 1,
                mapping: {},
                conversation_id: 'queued-missing-token',
                current_node: 'node-1',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'model',
                safe_urls: [],
                blocked_urls: [],
            }),
        } as any);

        (windowInstance as any).__BLACKIYA_SESSION_TOKEN__ = undefined;
        globalRef.__BLACKIYA_CAPTURE_QUEUE__ = [
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://chatgpt.com/backend-api/conversation/queued-missing-token',
                data: '{}',
            },
        ];
        globalRef.__BLACKIYA_LOG_QUEUE__ = [
            {
                type: 'LLM_LOG_ENTRY',
                payload: { level: 'info', message: 'missing-token', context: 'interceptor', data: [] },
            },
        ];

        manager.flushQueuedMessages();
        (manager as any).processQueuedLogMessages();
        expect(captured).toEqual([]);
        expect(loggerSpies.info).not.toHaveBeenCalledWith('[i] missing-token');

        setSessionToken('bk:test-interception-token');
        manager.flushQueuedMessages();
        expect(captured).toEqual(['queued-missing-token']);

        (manager as any).processPendingTokenRevalidationMessages();
        expect(loggerSpies.info).toHaveBeenCalledWith('[i] missing-token');
    });

    it('should cap queued messages pending token revalidation', () => {
        const manager = new InterceptionManager(() => {}, {
            window: windowInstance as any,
            global: globalThis,
        });
        const managerAny = manager as any;
        const maxPending = (InterceptionManager as any).MAX_PENDING_TOKEN_MESSAGES;

        (windowInstance as any).__BLACKIYA_SESSION_TOKEN__ = undefined;
        for (let i = 0; i < maxPending + 25; i++) {
            managerAny.tryQueueMessageForTokenRevalidation(
                {
                    type: 'LLM_LOG_ENTRY',
                    payload: { level: 'info', message: `queued-${i}`, context: 'interceptor', data: [] },
                },
                'LLM_LOG_ENTRY',
                'missing-message-token',
            );
        }

        expect(managerAny.pendingTokenRevalidationMessages.length).toBe(maxPending);
        manager.stop();
    });

    it('should stop retrying missing-token revalidation and drain pending messages after retry cap', () => {
        const manager = new InterceptionManager(() => {}, {
            window: windowInstance as any,
            global: globalThis,
        });
        const managerAny = manager as any;
        const maxRetries = (InterceptionManager as any).MAX_TOKEN_REVALIDATION_RETRIES;

        (windowInstance as any).__BLACKIYA_SESSION_TOKEN__ = undefined;
        managerAny.pendingTokenRevalidationMessages = [
            {
                type: 'LLM_LOG_ENTRY',
                payload: { level: 'info', message: 'pending-token-revalidation', context: 'interceptor', data: [] },
            },
        ];

        for (let i = 0; i < maxRetries + 1; i++) {
            managerAny.processPendingTokenRevalidationMessages();
        }

        expect(managerAny.pendingTokenRevalidationMessages).toEqual([]);
        expect(managerAny.pendingTokenRevalidationTimer).toBeNull();
        manager.stop();
    });

    it('should drop queued capture/log messages when token is mismatched', () => {
        const captured: string[] = [];
        const globalRef = {} as any;
        const manager = new InterceptionManager((id) => captured.push(id), {
            window: windowInstance as any,
            global: globalRef,
        });

        manager.updateAdapter({
            parseInterceptedData: () => ({
                title: 'Queued',
                create_time: 1,
                update_time: 1,
                mapping: {},
                conversation_id: 'queued-1',
                current_node: 'node-1',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'model',
                safe_urls: [],
                blocked_urls: [],
            }),
        } as any);

        globalRef.__BLACKIYA_CAPTURE_QUEUE__ = [
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://chatgpt.com/backend-api/conversation/queued-2',
                data: '{}',
                __blackiyaToken: 'bk:wrong-token',
            },
        ];

        globalRef.__BLACKIYA_LOG_QUEUE__ = [
            {
                type: 'LLM_LOG_ENTRY',
                payload: { level: 'info', message: 'wrong-token', context: 'interceptor', data: [] },
                __blackiyaToken: 'bk:wrong-token',
            },
        ];

        manager.flushQueuedMessages();
        (manager as any).processQueuedLogMessages();

        expect(captured).toEqual([]);
        expect(loggerSpies.info).not.toHaveBeenCalledWith('[i] wrong-token');
        expect(globalRef.__BLACKIYA_CAPTURE_QUEUE__).toEqual([]);
        expect(globalRef.__BLACKIYA_LOG_QUEUE__).toEqual([]);
    });

    it('should drop live window messages when token validation fails', () => {
        const captured: string[] = [];
        const manager = new InterceptionManager((id) => captured.push(id), {
            window: windowInstance as any,
            global: globalThis,
        });

        manager.updateAdapter({
            parseInterceptedData: () => ({
                title: 'Live',
                create_time: 1,
                update_time: 1,
                mapping: {},
                conversation_id: 'live-1',
                current_node: 'node-1',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'model',
                safe_urls: [],
                blocked_urls: [],
            }),
        } as any);

        manager.start();
        try {
            windowInstance.dispatchEvent(
                new (windowInstance as any).MessageEvent('message', {
                    data: {
                        type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                        url: 'https://chatgpt.com/backend-api/conversation/live-1',
                        data: '{}',
                    },
                    origin: windowInstance.location.origin,
                    source: windowInstance,
                }),
            );

            windowInstance.dispatchEvent(
                new (windowInstance as any).MessageEvent('message', {
                    data: {
                        type: 'LLM_LOG_ENTRY',
                        payload: { level: 'info', message: 'live-missing-token', context: 'interceptor', data: [] },
                    },
                    origin: windowInstance.location.origin,
                    source: windowInstance,
                }),
            );

            expect(captured).toEqual([]);
            expect(loggerSpies.info).not.toHaveBeenCalledWith('[i] live-missing-token');
        } finally {
            manager.stop();
        }
    });

    it('should cache direct conversation payloads from snapshot fallback', () => {
        const captured: string[] = [];
        const manager = new InterceptionManager((id) => captured.push(id), {
            window: windowInstance as any,
            global: globalThis,
        });

        manager.ingestConversationData({
            title: 'Snapshot Conversation',
            create_time: 1,
            update_time: 2,
            mapping: {},
            conversation_id: 'snapshot-123',
            current_node: 'snapshot-1',
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'snapshot',
            safe_urls: [],
            blocked_urls: [],
        });

        expect(captured).toEqual(['snapshot-123']);
        expect(manager.getConversation('snapshot-123')).toBeDefined();
    });

    it('should preserve existing non-generic title when snapshot ingest has generic title', () => {
        const manager = new InterceptionManager(() => {}, {
            window: windowInstance as any,
            global: globalThis,
        });

        manager.ingestConversationData({
            title: 'Wiping Over Splints and Travel',
            create_time: 1,
            update_time: 2,
            mapping: {},
            conversation_id: 'gemini-1',
            current_node: 'node-1',
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'gemini',
            safe_urls: [],
            blocked_urls: [],
        });

        manager.ingestConversationData(
            {
                title: 'Google Gemini',
                create_time: 1,
                update_time: 3,
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: [] },
                },
                conversation_id: 'gemini-1',
                current_node: 'root',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gemini',
                safe_urls: [],
                blocked_urls: [],
            },
            'stream-done-snapshot',
        );

        const cached = manager.getConversation('gemini-1');
        expect(cached).toBeDefined();
        expect(cached?.title).toBe('Wiping Over Splints and Travel');
        expect(cached?.update_time).toBe(3);
    });

    it('should accept non-generic snapshot title when existing title is generic', () => {
        const manager = new InterceptionManager(() => {}, {
            window: windowInstance as any,
            global: globalThis,
        });

        manager.ingestConversationData({
            title: 'Google Gemini',
            create_time: 1,
            update_time: 2,
            mapping: {},
            conversation_id: 'gemini-2',
            current_node: 'node-1',
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'gemini',
            safe_urls: [],
            blocked_urls: [],
        });

        manager.ingestConversationData(
            {
                title: 'Discussion on Istinja Rulings',
                create_time: 1,
                update_time: 3,
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: [] },
                },
                conversation_id: 'gemini-2',
                current_node: 'root',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gemini',
                safe_urls: [],
                blocked_urls: [],
            },
            'stream-done-snapshot',
        );

        const cached = manager.getConversation('gemini-2');
        expect(cached).toBeDefined();
        expect(cached?.title).toBe('Discussion on Istinja Rulings');
    });

    it('should keep previously seen non-generic title when later network ingest is generic', () => {
        const manager = new InterceptionManager(() => {}, {
            window: windowInstance as any,
            global: globalThis,
        });

        manager.ingestConversationData(
            {
                title: 'Wiping Over Splints and Travel',
                create_time: 1,
                update_time: 2,
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: [] },
                },
                conversation_id: 'gemini-3',
                current_node: 'root',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gemini',
                safe_urls: [],
                blocked_urls: [],
            },
            'network',
        );

        manager.ingestConversationData(
            {
                title: 'Google Gemini',
                create_time: 1,
                update_time: 3,
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: [] },
                },
                conversation_id: 'gemini-3',
                current_node: 'root',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gemini',
                safe_urls: [],
                blocked_urls: [],
            },
            'network',
        );

        const cached = manager.getConversation('gemini-3');
        expect(cached).toBeDefined();
        expect(cached?.title).toBe('Wiping Over Splints and Travel');
        expect(cached?.update_time).toBe(3);
    });

    it('should preserve cached object identity for snapshot refresh so delayed title mutation still lands', () => {
        const manager = new InterceptionManager(() => {}, {
            window: windowInstance as any,
            global: globalThis,
        });

        const networkConversation = {
            title: 'Google Gemini',
            create_time: 1,
            update_time: 2,
            mapping: {
                root: { id: 'root', message: null, parent: null, children: [] },
            },
            conversation_id: 'gemini-4',
            current_node: 'root',
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'gemini',
            safe_urls: [],
            blocked_urls: [],
        };

        manager.ingestConversationData(networkConversation, 'network');

        manager.ingestConversationData(
            {
                ...networkConversation,
                update_time: 3,
                mapping: {
                    'snapshot-1': {
                        id: 'snapshot-1',
                        message: {
                            id: 'snapshot-1',
                            author: { role: 'assistant', name: 'Gemini', metadata: {} },
                            content: { content_type: 'text', parts: ['Answer'] },
                            create_time: 3,
                            update_time: 3,
                            status: 'finished_successfully',
                            end_turn: true,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                        parent: null,
                        children: [],
                    },
                },
                current_node: 'snapshot-1',
            },
            'stream-done-snapshot',
        );

        // Simulates Gemini adapter's delayed title update via activeConversations cache.
        networkConversation.title = 'Discussion on Istinja Rulings';

        const cached = manager.getConversation('gemini-4');
        expect(cached).toBeDefined();
        expect(cached).toBe(networkConversation);
        expect(cached?.title).toBe('Discussion on Istinja Rulings');
        expect(cached?.update_time).toBe(3);
    });

    it('should ignore prototype-poisoning keys when merging snapshot data into existing cache object', () => {
        const manager = new InterceptionManager(() => {}, {
            window: windowInstance as any,
            global: globalThis,
        });

        const baseConversation = {
            title: 'Google Gemini',
            create_time: 1,
            update_time: 2,
            mapping: {
                root: { id: 'root', message: null, parent: null, children: [] },
            },
            conversation_id: 'gemini-safe-merge',
            current_node: 'root',
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'gemini',
            safe_urls: [],
            blocked_urls: [],
        };

        manager.ingestConversationData(baseConversation, 'network');

        const snapshotPayload = {
            ...baseConversation,
            update_time: 3,
        } as any;
        Object.defineProperty(snapshotPayload, '__proto__', {
            value: { polluted: true },
            enumerable: true,
            configurable: true,
        });

        manager.ingestConversationData(snapshotPayload, 'stream-done-snapshot');

        const cached = manager.getConversation('gemini-safe-merge');
        expect(cached).toBeDefined();
        expect((cached as any).polluted).toBeUndefined();
        expect((Object.prototype as any).polluted).toBeUndefined();
        expect(cached?.update_time).toBe(3);
    });
});
