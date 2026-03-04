/**
 * Regression tests for InterceptionManager.ingestConversationData merge behavior.
 *
 * Root cause: When a DOM snapshot is ingested after richer API-captured data,
 * mergeSnapshotIntoExisting naively overwrites all keys — destroying
 * default_model_slug (replacing e.g. 'gpt-5-2-thinking' with 'unknown') and
 * mapping message metadata (replacing rich model/reasoning metadata with {}).
 *
 * @see docs/model-reasoning-bug.md
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { setSessionToken } from '@/utils/protocol/session-token';
import type { ConversationData } from '@/utils/types';

mock.module('wxt/browser', () => ({
    browser: {
        storage: {
            onChanged: { addListener() {} },
            local: { get() {} },
        },
        runtime: { sendMessage() {} },
    },
}));

mock.module('@/utils/logger', () => ({
    logger: {
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
    },
}));

const buildRichApiConversation = (conversationId: string): ConversationData => ({
    title: 'Total authentic hadith count',
    create_time: 1772608923,
    update_time: 1772609000,
    conversation_id: conversationId,
    current_node: 'assistant-final',
    mapping: {
        root: { id: 'root', message: null, parent: null, children: ['user'] },
        user: {
            id: 'user',
            message: {
                id: 'user',
                author: { role: 'user', name: null, metadata: {} },
                create_time: 1772608920,
                update_time: 1772608920,
                content: { content_type: 'text', parts: ['How many hadith?'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: { resolved_model_slug: 'gpt-5-2-thinking' },
                recipient: 'all',
                channel: null,
            },
            parent: 'root',
            children: ['system-model', 'assistant-thinking'],
        },
        'system-model': {
            id: 'system-model',
            message: {
                id: 'system-model',
                author: { role: 'system', name: null, metadata: {} },
                create_time: 1772608921,
                update_time: null,
                content: { content_type: 'text', parts: [''] },
                status: 'finished_successfully',
                end_turn: null,
                weight: 1,
                metadata: {
                    model_slug: 'gpt-5-2-thinking',
                    default_model_slug: 'gpt-5-2-thinking',
                },
                recipient: 'all',
                channel: null,
            },
            parent: 'user',
            children: ['assistant-final'],
        },
        'assistant-thinking': {
            id: 'assistant-thinking',
            message: {
                id: 'assistant-thinking',
                author: { role: 'assistant', name: null, metadata: {} },
                create_time: 1772608922,
                update_time: null,
                content: {
                    content_type: 'thoughts',
                    thoughts: [
                        {
                            summary: 'Browsing for hadith counts',
                            content: 'Browsing for hadith counts and authenticity.',
                            chunks: ['Browsing for hadith counts and authenticity.'],
                            finished: true,
                        },
                    ],
                },
                status: 'finished_successfully',
                end_turn: null,
                weight: 1,
                metadata: { reasoning_status: 'is_reasoning', resolved_model_slug: 'gpt-5-2-thinking' },
                recipient: 'all',
                channel: null,
            },
            parent: 'user',
            children: [],
        },
        'assistant-final': {
            id: 'assistant-final',
            message: {
                id: 'assistant-final',
                author: { role: 'assistant', name: null, metadata: {} },
                create_time: 1772609000,
                update_time: null,
                content: { content_type: 'text', parts: ['There are approximately 4000 unique hadith...'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {
                    model_slug: 'gpt-5-2-thinking',
                    default_model_slug: 'gpt-5-2-thinking',
                    resolved_model_slug: 'gpt-5-2-thinking',
                },
                recipient: 'all',
                channel: null,
            },
            parent: 'system-model',
            children: [],
        },
    },
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'gpt-5-2-thinking',
    safe_urls: [],
    blocked_urls: [],
});

/**
 * Builds a DOM snapshot: assistant text is present, but model metadata is missing
 * and default_model_slug is 'unknown'.
 */
const buildDomSnapshot = (conversationId: string): ConversationData => {
    const now = Math.floor(Date.now() / 1000);
    return {
        title: 'Total authentic hadith count',
        create_time: now,
        update_time: now + 2,
        conversation_id: conversationId,
        current_node: `dom-${conversationId}-2`,
        mapping: {
            root: { id: 'root', message: null, parent: null, children: [`dom-${conversationId}-1`] },
            [`dom-${conversationId}-1`]: {
                id: `dom-${conversationId}-1`,
                message: {
                    id: `dom-${conversationId}-1`,
                    author: { role: 'user', name: null, metadata: {} },
                    create_time: now + 1,
                    update_time: now + 1,
                    content: { content_type: 'text', parts: ['How many hadith?'] },
                    status: 'finished_successfully',
                    end_turn: true,
                    weight: 1,
                    metadata: {},
                    recipient: 'all',
                    channel: null,
                },
                parent: 'root',
                children: [`dom-${conversationId}-2`],
            },
            [`dom-${conversationId}-2`]: {
                id: `dom-${conversationId}-2`,
                message: {
                    id: `dom-${conversationId}-2`,
                    author: { role: 'assistant', name: null, metadata: {} },
                    create_time: now + 2,
                    update_time: now + 2,
                    content: { content_type: 'text', parts: ['There are approximately 4000 unique hadith...'] },
                    status: 'finished_successfully',
                    end_turn: true,
                    weight: 1,
                    metadata: {},
                    recipient: 'all',
                    channel: null,
                },
                parent: `dom-${conversationId}-1`,
                children: [],
            },
        },
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: 'unknown',
        safe_urls: [],
        blocked_urls: [],
    };
};

describe('InterceptionManager — snapshot merge preserves model and reasoning', () => {
    let windowInstance: Window;
    let InterceptionManager: any;

    beforeEach(async () => {
        windowInstance = new Window();
        (windowInstance as any).SyntaxError = SyntaxError;
        (globalThis as any).window = windowInstance;
        (globalThis as any).document = windowInstance.document;
        windowInstance.location.href = 'https://chatgpt.com/c/test';
        setSessionToken('bk:test-merge-token');

        // Dynamic import to pick up the mocked logger
        const mod = await import('@/utils/managers/interception-manager');
        InterceptionManager = mod.InterceptionManager;
    });

    it('should NOT overwrite default_model_slug with "unknown" when existing has a real model', () => {
        const conversationId = '69a7dd92-test-merge';
        const captured: string[] = [];
        const manager = new InterceptionManager((id: string) => captured.push(id), {
            window: windowInstance as any,
            global: globalThis,
        });

        const chatgptAdapter = {
            name: 'ChatGPT',
            evaluateReadiness: () => ({ ready: true, terminal: true }),
        };
        manager.updateAdapter(chatgptAdapter as any);

        // Step 1: Ingest rich API data (from intercepted ChatGPT frontend polling)
        const richData = buildRichApiConversation(conversationId);
        manager.ingestConversationData(richData, 'network');

        // Step 2: Ingest DOM snapshot (which has default_model_slug: 'unknown')
        const snapshot = buildDomSnapshot(conversationId);
        manager.ingestConversationData(snapshot, 'stream-done-snapshot');

        // The merged data should preserve the richer default_model_slug
        const result = manager.getConversation(conversationId);
        expect(result).toBeDefined();
        expect(result!.default_model_slug).toBe('gpt-5-2-thinking');
    });

    it('should preserve message metadata with model_slug from existing API data after snapshot merge', () => {
        const conversationId = '69a7dd92-test-metadata';
        const captured: string[] = [];
        const manager = new InterceptionManager((id: string) => captured.push(id), {
            window: windowInstance as any,
            global: globalThis,
        });

        const chatgptAdapter = {
            name: 'ChatGPT',
            evaluateReadiness: () => ({ ready: true, terminal: true }),
        };
        manager.updateAdapter(chatgptAdapter as any);

        // Ingest rich API data
        const richData = buildRichApiConversation(conversationId);
        manager.ingestConversationData(richData, 'network');

        // Ingest DOM snapshot
        const snapshot = buildDomSnapshot(conversationId);
        manager.ingestConversationData(snapshot, 'stream-done-snapshot');

        // The merged mapping should still contain metadata with model_slug
        const result = manager.getConversation(conversationId);
        expect(result).toBeDefined();

        // Check that at least one message in the mapping has model_slug metadata
        const messagesWithModel = Object.values(result!.mapping)
            .map((node: any) => node.message)
            .filter((msg: any) => msg?.metadata?.model_slug || msg?.metadata?.resolved_model_slug);

        expect(messagesWithModel.length).toBeGreaterThan(0);
    });

    it('should preserve reasoning/thoughts from API data when snapshot has no thoughts', () => {
        const conversationId = '69a7dd92-test-reasoning';
        const captured: string[] = [];
        const manager = new InterceptionManager((id: string) => captured.push(id), {
            window: windowInstance as any,
            global: globalThis,
        });

        const chatgptAdapter = {
            name: 'ChatGPT',
            evaluateReadiness: () => ({ ready: true, terminal: true }),
        };
        manager.updateAdapter(chatgptAdapter as any);

        // Ingest rich API data (has thoughts nodes in mapping)
        const richData = buildRichApiConversation(conversationId);
        manager.ingestConversationData(richData, 'network');

        // Ingest DOM snapshot (no thoughts)
        const snapshot = buildDomSnapshot(conversationId);
        manager.ingestConversationData(snapshot, 'stream-done-snapshot');

        // After merge, the mapping should still contain reasoning nodes
        const result = manager.getConversation(conversationId);
        const thoughtNodes = Object.values(result!.mapping)
            .map((node: any) => node.message)
            .filter((msg: any) => msg?.content?.content_type === 'thoughts');

        expect(thoughtNodes.length).toBeGreaterThan(0);
    });

    it('should allow snapshot to update default_model_slug if existing is also a placeholder', () => {
        const conversationId = '69a7dd92-test-both-placeholder';
        const captured: string[] = [];
        const manager = new InterceptionManager((id: string) => captured.push(id), {
            window: windowInstance as any,
            global: globalThis,
        });

        const chatgptAdapter = {
            name: 'ChatGPT',
            evaluateReadiness: () => ({ ready: false, terminal: false }),
        };
        manager.updateAdapter(chatgptAdapter as any);

        // Ingest data with 'auto' model slug
        const existingData = buildRichApiConversation(conversationId);
        existingData.default_model_slug = 'auto';
        manager.ingestConversationData(existingData, 'network');

        // Ingest snapshot with 'unknown' — both are placeholders, allow overwrite
        const snapshot = buildDomSnapshot(conversationId);
        manager.ingestConversationData(snapshot, 'stream-done-snapshot');

        const result = manager.getConversation(conversationId);
        // When both are placeholders, the snapshot value can be used
        expect(['auto', 'unknown']).toContain(result!.default_model_slug);
    });
});
