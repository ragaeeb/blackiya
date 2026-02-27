import { describe, expect, it } from 'bun:test';
import type { ExternalConversationEvent } from '@/utils/external-api/contracts';
import {
    addTabDebugCaptureEntry,
    addTabDebugExternalEventEntry,
    buildTabDebugOverlayContent,
    buildTabDebugOverlaySnapshot,
    createTabDebugOverlayState,
    persistTabDebugOverlayVisibilityToSession,
    readTabDebugOverlayVisibilityFromSession,
} from '@/utils/runner/tab-debug-overlay';
import type { ConversationData } from '@/utils/types';

const createConversationData = (id: string): ConversationData => ({
    title: `Conversation ${id}`,
    create_time: 1_700_000_000,
    update_time: 1_700_000_001,
    conversation_id: id,
    current_node: 'assistant',
    mapping: {
        assistant: {
            id: 'assistant',
            message: {
                id: 'assistant',
                author: { role: 'assistant', name: null, metadata: {} },
                create_time: 1_700_000_001,
                update_time: 1_700_000_001,
                content: { content_type: 'text', parts: ['hello'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: 'final',
            },
            parent: null,
            children: [],
        },
    },
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'gpt-5',
    safe_urls: [],
    blocked_urls: [],
});

const createExternalEvent = (conversationId: string): ExternalConversationEvent => ({
    api: 'blackiya.events.v1',
    type: 'conversation.updated',
    event_id: `evt-${conversationId}`,
    ts: Date.now(),
    provider: 'chatgpt',
    tab_id: 1,
    conversation_id: conversationId,
    payload: createConversationData(conversationId),
    attempt_id: 'attempt-1',
    capture_meta: {
        captureSource: 'canonical_api',
        fidelity: 'high',
        completeness: 'complete',
    },
    content_hash: 'hash-1',
});

describe('tab-debug-overlay', () => {
    it('should persist and restore per-tab visibility state via session storage', () => {
        persistTabDebugOverlayVisibilityToSession(false);
        expect(readTabDebugOverlayVisibilityFromSession()).toBeFalse();

        persistTabDebugOverlayVisibilityToSession(true);
        expect(readTabDebugOverlayVisibilityFromSession()).toBeTrue();

        persistTabDebugOverlayVisibilityToSession(false);
        expect(readTabDebugOverlayVisibilityFromSession()).toBeFalse();
    });

    it('should add capture and emitted event entries to the overlay state', () => {
        const state = createTabDebugOverlayState();
        addTabDebugCaptureEntry(state, {
            conversationId: 'conv-1',
            source: 'network',
            payload: createConversationData('conv-1'),
            attemptId: 'attempt-1',
        });
        addTabDebugExternalEventEntry(state, {
            event: createExternalEvent('conv-1'),
            status: 'sent',
        });

        expect(state.entries).toHaveLength(2);
        expect(state.entries[0]?.kind).toBe('external');
        expect(state.entries[1]?.kind).toBe('capture');
    });

    it('should keep only bounded recent entries', () => {
        const state = createTabDebugOverlayState();
        for (let i = 0; i < 15; i += 1) {
            addTabDebugCaptureEntry(state, {
                conversationId: `conv-${i}`,
                source: 'network',
                payload: createConversationData(`conv-${i}`),
                attemptId: `attempt-${i}`,
            });
        }

        expect(state.entries).toHaveLength(12);
        expect(state.entries[0]?.kind).toBe('capture');
    });

    it('should render emitted payload details in overlay content', () => {
        const state = createTabDebugOverlayState();
        state.visible = true;
        addTabDebugExternalEventEntry(state, {
            event: createExternalEvent('conv-render'),
            status: 'failed',
            error: new Error('send failed'),
            delivery: {
                listenerCount: 3,
                delivered: 3,
                dropped: 0,
            },
        });

        const content = buildTabDebugOverlayContent(state);
        expect(content).toContain('[Blackiya Tab Debug]');
        expect(content).toContain('external:failed');
        expect(content).toContain('conversation.updated');
        expect(content).toContain('send failed');
        expect(content).toContain('listeners: 3');
        expect(content).toContain('"conversation_id": "conv-render"');
    });

    it('should build snapshot payload for active tab export', () => {
        const state = createTabDebugOverlayState();
        state.visible = true;
        addTabDebugCaptureEntry(state, {
            conversationId: 'conv-snapshot',
            source: 'network',
            payload: createConversationData('conv-snapshot'),
            attemptId: 'attempt-snapshot',
        });

        const snapshot = buildTabDebugOverlaySnapshot(state);
        expect(snapshot.api).toBe('blackiya.tab-debug-overlay.v1');
        expect(snapshot.visible).toBeTrue();
        expect(snapshot.recordCount).toBe(1);
        expect(snapshot.entries[0]?.kind).toBe('capture');
        expect(snapshot.content).toContain('conv-snapshot');
    });
});
