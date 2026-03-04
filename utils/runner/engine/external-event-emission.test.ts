import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';

const sentMessages: unknown[] = [];
let sendMessageBehavior: (message: unknown) => Promise<unknown> = async (message) => {
    sentMessages.push(message);
    return {
        success: true,
        delivery: {
            subscriberCount: 1,
            delivered: 1,
            dropped: 0,
        },
    };
};

mock.module('wxt/browser', () => ({
    browser: {
        runtime: {
            sendMessage: (message: unknown) => sendMessageBehavior(message),
        },
    },
}));

import { EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE } from '@/utils/external-api/contracts';
import { emitExternalConversationEvent } from '@/utils/runner/engine/external-event-emission';
import { createExternalEventDispatcherState } from '@/utils/runner/external-event-dispatch';
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

const buildConversationWithTitle = (conversationId: string, title: string): ConversationData => ({
    ...buildConversation(conversationId),
    title,
});

const buildConversationWithPrompt = (
    conversationId: string,
    options: { title: string; prompt: string; answer: string },
): ConversationData => ({
    title: options.title,
    create_time: 1_700_000_000,
    update_time: 1_700_000_001,
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
                content: { content_type: 'text', parts: [options.prompt] },
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
                author: { role: 'assistant', name: 'Assistant', metadata: {} },
                create_time: 1_700_000_001,
                update_time: 1_700_000_001,
                content: { content_type: 'text', parts: [options.answer] },
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
    default_model_slug: 'grok-3',
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

    beforeEach(() => {
        const win = new Window();
        originalWindow = (globalThis as any).window;
        originalDocument = (globalThis as any).document;
        (globalThis as any).window = win;
        (globalThis as any).document = win.document;
        sentMessages.length = 0;
        sendMessageBehavior = async (message) => {
            sentMessages.push(message);
            return {
                success: true,
                delivery: {
                    subscriberCount: 1,
                    delivered: 1,
                    dropped: 0,
                },
            };
        };
    });

    afterEach(() => {
        (globalThis as any).window = originalWindow;
        (globalThis as any).document = originalDocument;
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

    it('should emit conversation.updated when only the title changes', async () => {
        const ctx: any = {
            currentAdapter: {
                name: 'Grok',
                evaluateReadiness: () => ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:grok:1',
                    latestAssistantTextLength: 10,
                }),
            },
            currentConversationId: 'grok-conv-1',
            lifecycleState: 'completed',
            externalEventDispatchState: createExternalEventDispatcherState(),
            recordTabDebugExternalEvent: mock(() => {}),
        };

        emitExternalConversationEvent(ctx, {
            conversationId: 'grok-conv-1',
            data: buildConversationWithTitle('grok-conv-1', 'New conversation'),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'grok-attempt-1',
        });
        await Promise.resolve();

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toMatchObject({
            type: EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE,
            event: {
                type: 'conversation.ready',
                conversation_id: 'grok-conv-1',
                content_hash: 'hash:grok:1',
                payload: {
                    title: 'New conversation',
                },
            },
        });

        emitExternalConversationEvent(ctx, {
            conversationId: 'grok-conv-1',
            data: buildConversationWithTitle('grok-conv-1', 'Classical Islamic Texts Translation Guidelines'),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'grok-attempt-2',
        });
        await Promise.resolve();

        expect(sentMessages).toHaveLength(2);
        expect(sentMessages[1]).toMatchObject({
            type: EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE,
            event: {
                type: 'conversation.updated',
                conversation_id: 'grok-conv-1',
                content_hash: 'hash:grok:1',
                payload: {
                    title: 'Classical Islamic Texts Translation Guidelines',
                },
            },
        });
    });

    it('should resolve generic title from first user message before external emit', async () => {
        const ctx: any = {
            currentAdapter: {
                name: 'Grok',
                defaultTitles: ['New conversation'],
                extractConversationId: () => 'grok-conv-2',
                extractTitleFromDom: () => null,
                evaluateReadiness: () => ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:grok:prompt',
                    latestAssistantTextLength: 120,
                }),
            },
            currentConversationId: 'grok-conv-2',
            lifecycleState: 'completed',
            externalEventDispatchState: createExternalEventDispatcherState(),
            recordTabDebugExternalEvent: mock(() => {}),
            streamResolvedTitles: new Map<string, string>(),
        };

        emitExternalConversationEvent(ctx, {
            conversationId: 'grok-conv-2',
            data: buildConversationWithPrompt('grok-conv-2', {
                title: 'New conversation',
                prompt: 'Classical Islamic Texts Translation Guidelines',
                answer: 'Draft translation notes',
            }),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'grok-attempt-3',
        });
        await Promise.resolve();

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toMatchObject({
            type: EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE,
            event: {
                type: 'conversation.ready',
                conversation_id: 'grok-conv-2',
                payload: {
                    title: 'Classical Islamic Texts Translation Guidelines',
                },
            },
        });
    });

    it('should resolve generic title from first user message even when adapter default titles are unavailable', async () => {
        const ctx: any = {
            currentAdapter: {
                name: 'Grok',
                evaluateReadiness: () => ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:grok:no-defaults',
                    latestAssistantTextLength: 120,
                }),
            },
            currentConversationId: 'grok-conv-3',
            lifecycleState: 'completed',
            externalEventDispatchState: createExternalEventDispatcherState(),
            recordTabDebugExternalEvent: mock(() => {}),
            streamResolvedTitles: new Map<string, string>(),
        };

        emitExternalConversationEvent(ctx, {
            conversationId: 'grok-conv-3',
            data: buildConversationWithPrompt('grok-conv-3', {
                title: 'New conversation',
                prompt: 'Classical Islamic Texts Translation Guidelines',
                answer: 'Draft translation notes',
            }),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'grok-attempt-4',
        });
        await Promise.resolve();

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toMatchObject({
            type: EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE,
            event: {
                type: 'conversation.ready',
                conversation_id: 'grok-conv-3',
                payload: {
                    title: 'Classical Islamic Texts Translation Guidelines',
                },
            },
        });
    });

    it('should still apply stream-title precedence when adapter default titles are unavailable', async () => {
        const ctx: any = {
            currentAdapter: {
                name: 'Grok',
                extractConversationId: () => 'grok-conv-4',
                extractTitleFromDom: () => null,
                evaluateReadiness: () => ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:grok:no-defaults-stream',
                    latestAssistantTextLength: 120,
                }),
            },
            currentConversationId: 'grok-conv-4',
            lifecycleState: 'completed',
            externalEventDispatchState: createExternalEventDispatcherState(),
            recordTabDebugExternalEvent: mock(() => {}),
            streamResolvedTitles: new Map<string, string>([['grok-conv-4', 'Stream Selected Title']]),
        };

        emitExternalConversationEvent(ctx, {
            conversationId: 'grok-conv-4',
            data: buildConversationWithPrompt('grok-conv-4', {
                title: 'New conversation',
                prompt: 'Prompt-derived fallback title',
                answer: 'Draft translation notes',
            }),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'grok-attempt-5',
        });
        await Promise.resolve();

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toMatchObject({
            type: EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE,
            event: {
                type: 'conversation.ready',
                conversation_id: 'grok-conv-4',
                payload: {
                    title: 'Stream Selected Title',
                },
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

    it('should treat negative ACK as failed delivery and retry before marking sent', async () => {
        let attempt = 0;
        sendMessageBehavior = async (message) => {
            sentMessages.push(message);
            attempt += 1;
            if (attempt === 1) {
                return {
                    success: false,
                    error: 'hub_rejected',
                    delivery: {
                        subscriberCount: 1,
                        delivered: 0,
                        dropped: 1,
                    },
                };
            }
            return {
                success: true,
                delivery: {
                    subscriberCount: 1,
                    delivered: 1,
                    dropped: 0,
                },
            };
        };

        const debugEvents: Array<{ status?: string; delivery?: { listenerCount?: number; delivered?: number } }> = [];
        const recordTabDebugExternalEvent = mock(
            (entry: { status?: string; delivery?: { listenerCount?: number; delivered?: number } }) => {
                debugEvents.push(entry);
            },
        );
        const ctx: any = {
            currentAdapter: {
                name: 'ChatGPT',
                evaluateReadiness: () => ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:ack',
                    latestAssistantTextLength: 10,
                }),
            },
            currentConversationId: 'conv-ack',
            lifecycleState: 'completed',
            externalEventDispatchState: createExternalEventDispatcherState(),
            recordTabDebugExternalEvent,
            retryTimeoutIds: [],
        };

        emitExternalConversationEvent(ctx, {
            conversationId: 'conv-ack',
            data: buildConversation('conv-ack'),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'attempt-ack',
        });

        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(sentMessages).toHaveLength(2);
        const statuses = debugEvents.map((entry) => entry.status);
        expect(statuses).toContain('failed');
        expect(statuses).toContain('sent');
        expect(
            debugEvents.some(
                (entry) =>
                    entry.status === 'failed' && entry.delivery?.listenerCount === 1 && entry.delivery?.delivered === 0,
            ),
        ).toBeTrue();
    });

    it('should not mark dispatch state as sent when negative ACK persists across retries', async () => {
        sendMessageBehavior = async (message) => {
            sentMessages.push(message);
            return {
                success: false,
                error: 'hub_rejected',
                delivery: {
                    subscriberCount: 1,
                    delivered: 0,
                    dropped: 1,
                },
            };
        };

        const debugEvents: Array<{ status?: string }> = [];
        const ctx: any = {
            currentAdapter: {
                name: 'ChatGPT',
                evaluateReadiness: () => ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:ack-persistent',
                    latestAssistantTextLength: 10,
                }),
            },
            currentConversationId: 'conv-ack-persistent',
            lifecycleState: 'completed',
            externalEventDispatchState: createExternalEventDispatcherState(),
            recordTabDebugExternalEvent: mock((entry: { status?: string }) => {
                debugEvents.push(entry);
            }),
            retryTimeoutIds: [],
        };

        emitExternalConversationEvent(ctx, {
            conversationId: 'conv-ack-persistent',
            data: buildConversation('conv-ack-persistent'),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'attempt-ack-persistent',
        });

        await new Promise((resolve) => setTimeout(resolve, 500));

        expect(sentMessages).toHaveLength(4);
        expect(debugEvents.every((entry) => entry.status !== 'sent')).toBeTrue();
        expect(ctx.externalEventDispatchState.byConversation.has('conv-ack-persistent')).toBeFalse();
    });

    it('should suppress duplicate conversation.ready emits while first send is still in flight', async () => {
        let resolveFirstSend: ((value: unknown) => void) | null = null;
        let callCount = 0;
        sendMessageBehavior = async (message) => {
            sentMessages.push(message);
            callCount += 1;
            if (callCount === 1) {
                return await new Promise((resolve) => {
                    resolveFirstSend = resolve;
                });
            }
            return {
                success: true,
                delivery: {
                    subscriberCount: 1,
                    delivered: 1,
                    dropped: 0,
                },
            };
        };

        const ctx: any = {
            currentAdapter: {
                name: 'ChatGPT',
                evaluateReadiness: () => ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:pending-dedupe',
                    latestAssistantTextLength: 10,
                }),
            },
            currentConversationId: 'conv-pending-dedupe',
            lifecycleState: 'completed',
            externalEventDispatchState: createExternalEventDispatcherState(),
            recordTabDebugExternalEvent: mock(() => {}),
            retryTimeoutIds: [],
        };

        emitExternalConversationEvent(ctx, {
            conversationId: 'conv-pending-dedupe',
            data: buildConversation('conv-pending-dedupe'),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'attempt-pending-dedupe-1',
        });
        emitExternalConversationEvent(ctx, {
            conversationId: 'conv-pending-dedupe',
            data: buildConversation('conv-pending-dedupe'),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'attempt-pending-dedupe-2',
        });

        await Promise.resolve();
        expect(sentMessages).toHaveLength(1);
        expect(resolveFirstSend).not.toBeNull();

        if (!resolveFirstSend) {
            throw new Error('expected pending first send resolver');
        }
        const firstSendResolver = resolveFirstSend as (value: unknown) => void;
        firstSendResolver({
            success: true,
            delivery: {
                subscriberCount: 1,
                delivered: 1,
                dropped: 0,
            },
        });
        await Promise.resolve();

        expect(sentMessages).toHaveLength(1);
    });

    it('should retry when runtime sendMessage hangs beyond timeout', async () => {
        let callCount = 0;
        sendMessageBehavior = async (message) => {
            sentMessages.push(message);
            callCount += 1;
            if (callCount === 1) {
                return await new Promise(() => {});
            }
            return {
                success: true,
                delivery: {
                    subscriberCount: 1,
                    delivered: 1,
                    dropped: 0,
                },
            };
        };

        const debugEvents: Array<{ status?: string }> = [];
        const ctx: any = {
            currentAdapter: {
                name: 'ChatGPT',
                evaluateReadiness: () => ({
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash:timeout-retry',
                    latestAssistantTextLength: 10,
                }),
            },
            currentConversationId: 'conv-timeout-retry',
            lifecycleState: 'completed',
            externalEventDispatchState: createExternalEventDispatcherState(),
            recordTabDebugExternalEvent: mock((entry: { status?: string }) => {
                debugEvents.push(entry);
            }),
            retryTimeoutIds: [],
            externalEventSendTimeoutMs: 20,
        };

        emitExternalConversationEvent(ctx, {
            conversationId: 'conv-timeout-retry',
            data: buildConversation('conv-timeout-retry'),
            readinessMode: 'canonical_ready',
            captureMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
            attemptId: 'attempt-timeout-retry',
        });

        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(sentMessages).toHaveLength(2);
        expect(debugEvents.some((entry) => entry.status === 'failed')).toBeTrue();
        expect(debugEvents.some((entry) => entry.status === 'sent')).toBeTrue();
    });
});
