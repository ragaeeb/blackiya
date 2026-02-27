import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { browser } from 'wxt/browser';

const sentMessages: unknown[] = [];

import { EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE } from '@/utils/external-api/contracts';
import { createExternalEventDispatcherState } from '@/utils/runner/external-event-dispatch';
import { emitExternalConversationEvent } from '@/utils/runner/runner-engine-context';
import type { ConversationData } from '@/utils/types';

const buildConversation = (conversationId: string): ConversationData => ({
    title: 'Test',
    create_time: 1_700_000_000,
    update_time: 1_700_000_001,
    mapping: {
        root: { id: 'root', message: null, parent: null, children: [] },
    },
    conversation_id: conversationId,
    current_node: 'root',
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'gpt',
    safe_urls: [],
    blocked_urls: [],
});

const buildGeminiAssistantOnlyConversation = (conversationId: string): ConversationData => ({
    title: 'Gemini Conversation',
    create_time: 1_700_000_000,
    update_time: 1_700_000_001,
    mapping: {
        root: { id: 'root', message: null, parent: null, children: ['assistant-1'] },
        'assistant-1': {
            id: 'assistant-1',
            parent: 'root',
            children: [],
            message: {
                id: 'assistant-1',
                author: { role: 'assistant', name: 'Gemini', metadata: {} },
                create_time: 1_700_000_000,
                update_time: 1_700_000_001,
                content: { content_type: 'text', parts: ['Draft answer only'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        },
    },
    conversation_id: conversationId,
    current_node: 'assistant-1',
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'gemini-2.5-pro',
    safe_urls: [],
    blocked_urls: [],
});

const buildGeminiPromptedConversation = (conversationId: string): ConversationData => ({
    title: 'Gemini Conversation',
    create_time: 1_700_000_000,
    update_time: 1_700_000_002,
    mapping: {
        root: { id: 'root', message: null, parent: null, children: ['user-1'] },
        'user-1': {
            id: 'user-1',
            parent: 'root',
            children: ['assistant-1'],
            message: {
                id: 'user-1',
                author: { role: 'user', name: 'User', metadata: {} },
                create_time: 1_700_000_000,
                update_time: 1_700_000_000,
                content: { content_type: 'text', parts: ['Original prompt text'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        },
        'assistant-1': {
            id: 'assistant-1',
            parent: 'user-1',
            children: [],
            message: {
                id: 'assistant-1',
                author: { role: 'assistant', name: 'Gemini', metadata: {} },
                create_time: 1_700_000_001,
                update_time: 1_700_000_002,
                content: { content_type: 'text', parts: ['Final answer'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        },
    },
    conversation_id: conversationId,
    current_node: 'assistant-1',
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'gemini-2.5-pro',
    safe_urls: [],
    blocked_urls: [],
});

describe('runner external event emission', () => {
    let originalWindow: unknown;
    let originalDocument: unknown;
    let originalSendMessage: unknown;
    let hadSendMessage = false;

    beforeEach(() => {
        const win = new Window();
        originalWindow = (globalThis as any).window;
        originalDocument = (globalThis as any).document;
        (globalThis as any).window = win;
        (globalThis as any).document = win.document;

        const browserAny = browser as any;
        if (!browserAny.runtime) {
            browserAny.runtime = {};
        }
        const runtime = browserAny.runtime;
        hadSendMessage = typeof runtime.sendMessage === 'function';
        originalSendMessage = runtime.sendMessage;
        runtime.sendMessage = async (message: unknown) => {
            sentMessages.push(message);
            return undefined;
        };

        sentMessages.length = 0;
    });

    afterEach(() => {
        (globalThis as any).window = originalWindow;
        (globalThis as any).document = originalDocument;
        const browserAny = browser as any;
        if (!browserAny.runtime) {
            browserAny.runtime = {};
        }
        const runtime = browserAny.runtime;
        if (hadSendMessage) {
            runtime.sendMessage = originalSendMessage;
        } else {
            delete runtime.sendMessage;
        }
        sentMessages.length = 0;
    });

    it('should emit conversation.ready once and conversation.updated on hash changes', async () => {
        const ctx: any = {
            currentAdapter: {
                name: 'ChatGPT',
                evaluateReadiness: () => ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:1',
                    latestAssistantTextLength: 10,
                }),
            },
            currentConversationId: 'conv-1',
            lifecycleState: 'completed',
            externalEventDispatchState: createExternalEventDispatcherState(),
            recordTabDebugExternalEvent: mock(() => {}),
        };

        emitExternalConversationEvent(ctx, {
            conversationId: 'conv-1',
            data: buildConversation('conv-1'),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'attempt-1',
        });
        await Promise.resolve();

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toMatchObject({
            type: EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE,
            event: {
                type: 'conversation.ready',
                conversation_id: 'conv-1',
                provider: 'chatgpt',
                content_hash: 'hash:1',
            },
        });

        emitExternalConversationEvent(ctx, {
            conversationId: 'conv-1',
            data: buildConversation('conv-1'),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'attempt-1b',
        });
        await Promise.resolve();
        expect(sentMessages).toHaveLength(1);

        ctx.currentAdapter.evaluateReadiness = () => ({
            ready: true,
            terminal: true,
            reason: 'terminal',
            contentHash: 'hash:2',
            latestAssistantTextLength: 12,
        });

        emitExternalConversationEvent(ctx, {
            conversationId: 'conv-1',
            data: buildConversation('conv-1'),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'attempt-2',
        });
        await Promise.resolve();

        expect(sentMessages).toHaveLength(2);
        expect(sentMessages[1]).toMatchObject({
            type: EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE,
            event: {
                type: 'conversation.updated',
                content_hash: 'hash:2',
            },
        });
    });

    it('should allow canonical external event emission while lifecycle is still streaming when explicitly allowed', async () => {
        const ctx: any = {
            currentAdapter: {
                name: 'ChatGPT',
                evaluateReadiness: () => ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:streaming',
                    latestAssistantTextLength: 10,
                }),
            },
            currentConversationId: 'conv-streaming',
            lifecycleState: 'streaming',
            externalEventDispatchState: createExternalEventDispatcherState(),
            recordTabDebugExternalEvent: mock(() => {}),
        };

        emitExternalConversationEvent(ctx, {
            conversationId: 'conv-streaming',
            data: buildConversation('conv-streaming'),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'attempt-streaming-blocked',
        });
        await Promise.resolve();
        expect(sentMessages).toHaveLength(0);

        emitExternalConversationEvent(ctx, {
            conversationId: 'conv-streaming',
            data: buildConversation('conv-streaming'),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'attempt-streaming-allowed',
            allowWhenActionsBlocked: true,
        });
        await Promise.resolve();
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toMatchObject({
            type: EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE,
            event: {
                type: 'conversation.ready',
                conversation_id: 'conv-streaming',
            },
        });
    });

    it('should suppress Gemini external ready events until a non-empty user prompt exists', async () => {
        const ctx: any = {
            currentAdapter: {
                name: 'Gemini',
                evaluateReadiness: () => ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:gemini:1',
                    latestAssistantTextLength: 12,
                }),
            },
            currentConversationId: 'gemini-conv-1',
            lifecycleState: 'completed',
            externalEventDispatchState: createExternalEventDispatcherState(),
            recordTabDebugExternalEvent: mock(() => {}),
        };

        emitExternalConversationEvent(ctx, {
            conversationId: 'gemini-conv-1',
            data: buildGeminiAssistantOnlyConversation('gemini-conv-1'),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'gemini-attempt-1',
        });
        await Promise.resolve();
        expect(sentMessages).toHaveLength(0);

        ctx.currentAdapter.evaluateReadiness = () => ({
            ready: true,
            terminal: true,
            reason: 'terminal',
            contentHash: 'hash:gemini:2',
            latestAssistantTextLength: 20,
        });

        emitExternalConversationEvent(ctx, {
            conversationId: 'gemini-conv-1',
            data: buildGeminiPromptedConversation('gemini-conv-1'),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'gemini-attempt-2',
        });
        await Promise.resolve();

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toMatchObject({
            type: EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE,
            event: {
                type: 'conversation.ready',
                conversation_id: 'gemini-conv-1',
                provider: 'gemini',
            },
        });
    });
});
