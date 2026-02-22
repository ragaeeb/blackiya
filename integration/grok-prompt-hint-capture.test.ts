import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { cachePromptHintFromGrokCreateConversationRequest } from '@/entrypoints/interceptor/bootstrap-lifecycle';
import { createInterceptorEmitter, type InterceptorEmitterState } from '@/entrypoints/interceptor/interceptor-emitter';
import { InterceptionManager } from '@/utils/managers/interception-manager';
import { getSessionToken, setSessionToken } from '@/utils/protocol/session-token';

mock.module('@/utils/logger', () => ({
    logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    },
}));

describe('integration: grok prompt hint backfill across interceptor and manager', () => {
    let windowRef: Window;

    beforeEach(() => {
        windowRef = new Window();
        (globalThis as any).window = windowRef as any;
        (globalThis as any).document = windowRef.document;
        setSessionToken('bk:test-grok-prompt-hint');
        (windowRef as any).__BLACKIYA_SESSION_TOKEN__ = 'bk:test-grok-prompt-hint';
    });

    it('should backfill missing Grok user prompt from add_response request prompt hint', async () => {
        const conversationId = '2025624158701305984';
        const userNodeId = '2025624159431098368';
        const assistantNodeId = '2025624159431098369';
        const attemptId = 'grok:attempt-42';
        const promptText = 'Translate this exactly with strict formatting.';

        const manager = new InterceptionManager(() => {}, {
            window: windowRef as any,
            global: globalThis,
        });
        manager.updateAdapter({
            name: 'Grok',
            urlMatchPattern: 'https://x.com/*',
            apiEndpointPattern: /grok/i,
            isPlatformUrl: () => true,
            extractConversationId: () => conversationId,
            parseInterceptedData: () => ({
                title: 'Grok Conversation',
                create_time: 1771781169.271,
                update_time: 1771781169.271,
                mapping: {
                    [`grok-com-root-${conversationId}`]: {
                        id: `grok-com-root-${conversationId}`,
                        message: null,
                        parent: null,
                        children: [userNodeId],
                    },
                    [userNodeId]: {
                        id: userNodeId,
                        message: null,
                        parent: `grok-com-root-${conversationId}`,
                        children: [assistantNodeId],
                    },
                    [assistantNodeId]: {
                        id: assistantNodeId,
                        parent: userNodeId,
                        children: [],
                        message: {
                            id: assistantNodeId,
                            author: { role: 'assistant', name: 'Grok', metadata: {} },
                            create_time: 1771781169.271,
                            update_time: null,
                            content: { content_type: 'text', parts: ['assistant response'] },
                            status: 'finished_successfully',
                            end_turn: true,
                            weight: 1,
                            metadata: { sender: 'assistant', model: 'grok-3' },
                            recipient: 'all',
                            channel: null,
                        },
                    },
                },
                conversation_id: conversationId,
                current_node: assistantNodeId,
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'grok-3',
                safe_urls: [],
                blocked_urls: [],
            }),
            formatFilename: () => 'grok',
            getButtonInjectionTarget: () => windowRef.document.body as any,
        } as any);
        manager.start();

        const state: InterceptorEmitterState = {
            completionSignalCache: new Map<string, number>(),
            transientLogCache: new Map<string, number>(),
            capturePayloadCache: new Map<string, number>(),
            lifecycleSignalCache: new Map<string, number>(),
            conversationResolvedSignalCache: new Map<string, number>(),
            promptHintByAttempt: new Map<string, string>(),
            streamDumpFrameCountByAttempt: new Map<string, number>(),
            streamDumpLastTextByAttempt: new Map<string, string>(),
            lastCachePruneAtMs: 0,
            streamDumpEnabled: false,
        };

        const emitter = createInterceptorEmitter({
            state,
            maxDedupeEntries: 200,
            maxStreamDumpAttempts: 50,
            cacheTtlMs: 60_000,
            cachePruneIntervalMs: 15_000,
            defaultPlatformName: 'Grok',
            resolveAttemptIdForConversation: () => attemptId,
            bindAttemptToConversation: () => {},
            isAttemptDisposed: () => false,
            appendToLogQueue: () => {},
            appendToCaptureQueue: () => {},
        });

        const request = new Request('https://grok.x.com/2/grok/add_response.json', {
            method: 'POST',
            body: JSON.stringify({
                responses: [{ message: promptText, sender: 1, promptSource: '' }],
                promptMetadata: { promptSource: 'NATURAL', action: 'INPUT' },
                conversationId,
            }),
        });

        const context = {
            args: [request] as unknown as Parameters<typeof fetch>,
            outgoingMethod: 'POST',
            outgoingUrl: 'https://grok.x.com/2/grok/add_response.json',
            nonChatAttemptId: attemptId,
        } as const;

        await cachePromptHintFromGrokCreateConversationRequest(context, {
            emitter: emitter as any,
            resolveAttemptIdForConversation: () => attemptId,
        });

        emitter.emitCapturePayload('https://x.com/2/grok/add_response.json', '{"ok":true}', 'Grok', attemptId);

        await new Promise((resolve) => setTimeout(resolve, 0));

        const saved = manager.getConversation(conversationId);
        expect(saved).toBeDefined();
        expect(saved?.mapping[userNodeId]?.message?.author.role).toBe('user');
        expect(saved?.mapping[userNodeId]?.message?.content.parts?.[0]).toBe(promptText);
        expect(getSessionToken()).toBe('bk:test-grok-prompt-hint');

        manager.stop();
    });
});
