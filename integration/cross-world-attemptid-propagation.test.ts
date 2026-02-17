import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';

mock.module('@/utils/logger', () => ({
    logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    },
}));

import { InterceptionManager } from '@/utils/managers/interception-manager';

describe('integration: cross-world attemptId propagation', () => {
    let windowRef: any;

    beforeEach(() => {
        windowRef = new Window();
        (globalThis as any).window = windowRef as any;
        (globalThis as any).document = windowRef.document;
    });

    it('propagates attemptId from queued capture payload to callback meta', () => {
        const observed: Array<{ conversationId: string; attemptId?: string }> = [];

        const manager = new InterceptionManager(
            (conversationId, _data, meta) => {
                observed.push({
                    conversationId,
                    attemptId: meta?.attemptId,
                });
            },
            {
                window: windowRef,
                global: globalThis,
            },
        );

        manager.updateAdapter({
            name: 'ChatGPT',
            urlMatchPattern: 'https://chatgpt.com/*',
            apiEndpointPattern: /chatgpt/,
            isPlatformUrl: () => true,
            extractConversationId: () => 'c1',
            parseInterceptedData: () => ({
                title: 't',
                create_time: 1,
                update_time: 2,
                mapping: {},
                conversation_id: 'c1',
                current_node: 'root',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'x',
                safe_urls: [],
                blocked_urls: [],
            }),
            formatFilename: () => 'x',
            getButtonInjectionTarget: () => windowRef.document.body as any,
        });

        (globalThis as any).__BLACKIYA_CAPTURE_QUEUE__ = [
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://chatgpt.com/backend-api/conversation/c1',
                data: '{}',
                platform: 'ChatGPT',
                attemptId: 'attempt:1',
            },
        ];

        manager.start();

        expect(observed.length).toBe(1);
        expect(observed[0]).toEqual({
            conversationId: 'c1',
            attemptId: 'attempt:1',
        });

        manager.stop();
    });
});
