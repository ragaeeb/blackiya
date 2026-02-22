import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';

const sentMessages: unknown[] = [];

mock.module('wxt/browser', () => ({
    browser: {
        runtime: {
            sendMessage: async (message: unknown) => {
                sentMessages.push(message);
                return undefined;
            },
        },
    },
}));

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
});
