import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';

// Mock logger to avoid wxt/browser dependency in tests
mock.module('@/utils/logger', () => ({
    logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    },
}));

import { InterceptionManager } from './interception-manager';

describe('InterceptionManager', () => {
    const windowInstance = new Window();
    const document = windowInstance.document;

    beforeEach(() => {
        (global as any).window = windowInstance;
        (global as any).document = document;
        (globalThis as any).window = windowInstance;
        (global as any).alert = () => {};

        windowInstance.location.href = 'https://chatgpt.com/c/123';
        (global as any).window.__BLACKIYA_CAPTURE_QUEUE__ = [];
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
});
