import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ConversationData } from '@/utils/types';
import { EXTERNAL_API_VERSION, type ExternalConversationEvent } from '@/utils/external-api/contracts';
import { createExternalApiHub, type ExternalPortLike, type ExternalStorageLike } from '@/utils/external-api/background-hub';

const buildConversation = (conversationId: string, response = 'Assistant response'): ConversationData => ({
    title: 'Test Conversation',
    create_time: 1_700_000_000,
    update_time: 1_700_000_010,
    mapping: {
        root: { id: 'root', message: null, parent: null, children: ['u-1'] },
        'u-1': {
            id: 'u-1',
            parent: 'root',
            children: ['a-1'],
            message: {
                id: 'u-1',
                author: { role: 'user', name: null, metadata: {} },
                create_time: 1_700_000_001,
                update_time: 1_700_000_001,
                content: { content_type: 'text', parts: ['User prompt'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        },
        'a-1': {
            id: 'a-1',
            parent: 'u-1',
            children: [],
            message: {
                id: 'a-1',
                author: { role: 'assistant', name: null, metadata: {} },
                create_time: 1_700_000_002,
                update_time: 1_700_000_002,
                content: { content_type: 'text', parts: [response] },
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
    current_node: 'a-1',
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'gpt',
    safe_urls: [],
    blocked_urls: [],
});

const buildEvent = (
    conversationId: string,
    type: ExternalConversationEvent['type'] = 'conversation.ready',
): ExternalConversationEvent => ({
    api: EXTERNAL_API_VERSION,
    type,
    event_id: `evt-${conversationId}-${type}`,
    ts: Date.now(),
    provider: 'chatgpt' as const,
    conversation_id: conversationId,
    payload: buildConversation(conversationId),
    capture_meta: {
        captureSource: 'canonical_api' as const,
        fidelity: 'high' as const,
        completeness: 'complete' as const,
    },
    content_hash: `hash:${conversationId}`,
    attempt_id: `attempt:${conversationId}`,
});

const createMemoryStorage = (): ExternalStorageLike & { backing: Record<string, unknown> } => {
    const backing: Record<string, unknown> = {};
    return {
        backing,
        get: async (key) => ({ [key]: backing[key] }),
        set: async (items) => {
            for (const [key, value] of Object.entries(items)) {
                backing[key] = value;
            }
        },
    };
};

const createFakePort = (name: string): ExternalPortLike & { disconnectNow: () => void } => {
    const disconnectHandlers = new Set<(port: ExternalPortLike) => void>();
    const port: ExternalPortLike & { disconnectNow: () => void } = {
        name,
        postMessage: mock(() => {}),
        onDisconnect: {
            addListener: (listener) => {
                disconnectHandlers.add(listener);
            },
            removeListener: (listener) => {
                disconnectHandlers.delete(listener);
            },
        },
        disconnect: mock(() => {}),
        disconnectNow: () => {
            for (const listener of disconnectHandlers) {
                listener(port);
            }
        },
    };
    return port;
};

describe('background external api hub', () => {
    let storage: ExternalStorageLike & { backing: Record<string, unknown> };

    beforeEach(() => {
        storage = createMemoryStorage();
    });

    it('should broadcast ingested events to connected subscribers', async () => {
        const hub = createExternalApiHub({ storage, now: () => 1_000 });
        const port = createFakePort(EXTERNAL_API_VERSION);
        hub.addSubscriber(port);

        await hub.ingestEvent(buildEvent('conv-1'), 42);

        expect(port.postMessage).toHaveBeenCalledTimes(1);
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                api: EXTERNAL_API_VERSION,
                type: 'conversation.ready',
                conversation_id: 'conv-1',
                tab_id: 42,
            }),
        );
    });

    it('should return latest conversation for conversation.getLatest pull request', async () => {
        const hub = createExternalApiHub({ storage, now: () => 2_000 });
        await hub.ingestEvent(buildEvent('conv-1'), 9);

        const response = await hub.handleExternalRequest({
            api: EXTERNAL_API_VERSION,
            type: 'conversation.getLatest',
        });

        expect(response).toMatchObject({
            ok: true,
            api: EXTERNAL_API_VERSION,
            conversation_id: 'conv-1',
            format: 'original',
        });
        if (response.ok && 'data' in response) {
            expect((response.data as ConversationData).conversation_id).toBe('conv-1');
        }
    });

    it('should return common-format payload for pull format common', async () => {
        const hub = createExternalApiHub({ storage, now: () => 3_000 });
        await hub.ingestEvent(buildEvent('conv-1'), 9);

        const response = await hub.handleExternalRequest({
            api: EXTERNAL_API_VERSION,
            type: 'conversation.getLatest',
            format: 'common',
        });

        expect(response).toMatchObject({
            ok: true,
            api: EXTERNAL_API_VERSION,
            conversation_id: 'conv-1',
            format: 'common',
        });
        if (response.ok && 'data' in response) {
            expect(response.data).toMatchObject({
                format: 'common',
                llm: 'ChatGPT',
                conversation_id: 'conv-1',
            });
        }
    });

    it('should return not_found for missing conversation.getById', async () => {
        const hub = createExternalApiHub({ storage, now: () => 4_000 });
        const response = await hub.handleExternalRequest({
            api: EXTERNAL_API_VERSION,
            type: 'conversation.getById',
            conversation_id: 'does-not-exist',
        });

        expect(response).toEqual({
            ok: false,
            api: EXTERNAL_API_VERSION,
            code: 'NOT_FOUND',
            message: 'Conversation not found',
            ts: 4_000,
        });
    });

    it('should restore cached latest conversation from storage backup after restart', async () => {
        {
            const firstHub = createExternalApiHub({ storage, now: () => 5_000 });
            await firstHub.ingestEvent(buildEvent('conv-9'), 7);
        }

        const secondHub = createExternalApiHub({ storage, now: () => 6_000 });
        const response = await secondHub.handleExternalRequest({
            api: EXTERNAL_API_VERSION,
            type: 'conversation.getLatest',
        });

        expect(response).toMatchObject({
            ok: true,
            conversation_id: 'conv-9',
            format: 'original',
        });
    });

    it('should reject invalid pull request payloads', async () => {
        const hub = createExternalApiHub({ storage, now: () => 7_000 });
        const response = await hub.handleExternalRequest({
            api: 'blackiya.events.v0',
            type: 'conversation.getLatest',
        });

        expect(response).toEqual({
            ok: false,
            api: EXTERNAL_API_VERSION,
            code: 'INVALID_REQUEST',
            message: 'Invalid external API request',
            ts: 7_000,
        });
    });

    it('should ignore disconnected subscribers during broadcast', async () => {
        const hub = createExternalApiHub({ storage, now: () => 8_000 });
        const port = createFakePort(EXTERNAL_API_VERSION);
        hub.addSubscriber(port);
        port.disconnectNow();

        await hub.ingestEvent(buildEvent('conv-1'));
        expect(port.postMessage).not.toHaveBeenCalled();
    });
});
