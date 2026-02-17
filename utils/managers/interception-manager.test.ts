import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';

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
            },
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://chatgpt.com/backend-api/conversation/two',
                data: JSON.stringify({ conversation_id: 'two', mapping: {} }),
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
            },
            {
                type: 'LLM_LOG_ENTRY',
                payload: { level: 'info', message: 'second', data: [], context: 'interceptor' },
            },
            {
                type: 'LLM_LOG_ENTRY',
                payload: { level: 'info', message: 'third', data: [], context: 'interceptor' },
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
});
