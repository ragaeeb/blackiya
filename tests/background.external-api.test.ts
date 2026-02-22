import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
    createExternalApiHub,
    type ExternalPortLike,
    type ExternalStorageLike,
} from '@/utils/external-api/background-hub';
import { EXTERNAL_CACHE_STORAGE_KEY } from '@/utils/external-api/constants';
import { EXTERNAL_API_VERSION, type ExternalConversationEvent } from '@/utils/external-api/contracts';
import type { ConversationData } from '@/utils/types';

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

// This helper intentionally couples to the persisted hub snapshot shape
// (`{ [storageKey]: { records: [...] } }`) to force quota failures when record
// count is greater than one. The quota test also asserts writes/backing state,
// so if serialization changes this helper should be updated with the test.
const createQuotaConstrainedStorage = (): ExternalStorageLike & {
    backing: Record<string, unknown>;
    writes: number;
} => {
    const backing: Record<string, unknown> = {};
    let writes = 0;
    return {
        backing,
        get writes() {
            return writes;
        },
        get: async (key) => ({ [key]: backing[key] }),
        set: async (items) => {
            const firstValue = Object.values(items)[0] as { records?: unknown[] } | undefined;
            const recordCount = Array.isArray(firstValue?.records) ? firstValue.records.length : 0;
            writes += 1;
            if (recordCount > 1) {
                throw new Error('Exceeded QUOTA_BYTES');
            }
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
        const hub = createExternalApiHub({ storage, now: () => 1_000, persistDebounceMs: 0 });
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
        const hub = createExternalApiHub({ storage, now: () => 2_000, persistDebounceMs: 0 });
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
        const hub = createExternalApiHub({ storage, now: () => 3_000, persistDebounceMs: 0 });
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

    it('should return latest conversation filtered by tab id when requested', async () => {
        const hub = createExternalApiHub({ storage, now: () => 3_500, persistDebounceMs: 0 });
        await hub.ingestEvent(buildEvent('conv-tab-1'), 1);
        await hub.ingestEvent(buildEvent('conv-tab-2'), 2);

        const response = await hub.handleExternalRequest({
            api: EXTERNAL_API_VERSION,
            type: 'conversation.getLatest',
            tab_id: 1,
        });

        expect(response).toMatchObject({
            ok: true,
            api: EXTERNAL_API_VERSION,
            conversation_id: 'conv-tab-1',
            format: 'original',
        });
    });

    it('should return not_found for missing conversation.getById', async () => {
        const hub = createExternalApiHub({ storage, now: () => 4_000, persistDebounceMs: 0 });
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
            const firstHub = createExternalApiHub({ storage, now: () => 5_000, persistDebounceMs: 0 });
            await firstHub.ingestEvent(buildEvent('conv-9'), 7);
        }

        const secondHub = createExternalApiHub({ storage, now: () => 6_000, persistDebounceMs: 0 });
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

    it('should recover latest conversation by timestamp when persisted latest id is stale', async () => {
        storage.backing[EXTERNAL_CACHE_STORAGE_KEY] = {
            latestConversationId: 'stale-id',
            records: [
                {
                    conversation_id: 'conv-1',
                    provider: 'chatgpt',
                    payload: buildConversation('conv-1'),
                    attempt_id: 'attempt-1',
                    capture_meta: {
                        captureSource: 'canonical_api',
                        fidelity: 'high',
                        completeness: 'complete',
                    },
                    content_hash: 'hash:1',
                    ts: 10,
                },
                {
                    conversation_id: 'conv-2',
                    provider: 'chatgpt',
                    payload: buildConversation('conv-2'),
                    attempt_id: 'attempt-2',
                    capture_meta: {
                        captureSource: 'canonical_api',
                        fidelity: 'high',
                        completeness: 'complete',
                    },
                    content_hash: 'hash:2',
                    ts: 20,
                },
            ],
        };

        const hub = createExternalApiHub({ storage, now: () => 6_500, persistDebounceMs: 0 });
        const response = await hub.handleExternalRequest({
            api: EXTERNAL_API_VERSION,
            type: 'conversation.getLatest',
        });

        expect(response).toMatchObject({
            ok: true,
            conversation_id: 'conv-2',
            format: 'original',
        });
    });

    it('should ignore malformed persisted capture_meta records during hydration', async () => {
        storage.backing[EXTERNAL_CACHE_STORAGE_KEY] = {
            latestConversationId: 'conv-1',
            records: [
                {
                    conversation_id: 'conv-1',
                    provider: 'chatgpt',
                    payload: buildConversation('conv-1'),
                    attempt_id: 'attempt-1',
                    capture_meta: {
                        // malformed values should fail strict validation
                        captureSource: 'bad-source',
                        fidelity: 'high',
                        completeness: 'complete',
                    },
                    content_hash: 'hash:1',
                    ts: 10,
                },
            ],
        };

        const hub = createExternalApiHub({ storage, now: () => 6_700, persistDebounceMs: 0 });
        const response = await hub.handleExternalRequest({
            api: EXTERNAL_API_VERSION,
            type: 'conversation.getLatest',
        });

        expect(response).toEqual({
            ok: false,
            api: EXTERNAL_API_VERSION,
            code: 'UNAVAILABLE',
            message: 'No conversation data available',
            ts: 6_700,
        });
    });

    it('should reject invalid pull request payloads', async () => {
        const hub = createExternalApiHub({ storage, now: () => 7_000, persistDebounceMs: 0 });
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

    it('should disconnect subscribers with invalid port names', () => {
        const hub = createExternalApiHub({ storage, now: () => 7_500, persistDebounceMs: 0 });
        const wrongPort = createFakePort('wrong.port');

        const accepted = hub.addSubscriber(wrongPort);

        expect(accepted).toBeFalse();
        expect(wrongPort.disconnect).toHaveBeenCalledTimes(1);
    });

    it('should ignore disconnected subscribers during broadcast', async () => {
        const hub = createExternalApiHub({ storage, now: () => 8_000, persistDebounceMs: 0 });
        const port = createFakePort(EXTERNAL_API_VERSION);
        hub.addSubscriber(port);
        port.disconnectNow();

        await hub.ingestEvent(buildEvent('conv-1'));
        expect(port.postMessage).not.toHaveBeenCalled();
    });

    it('should retry persistence with smaller snapshots on quota errors', async () => {
        const quotaStorage = createQuotaConstrainedStorage();
        const hub = createExternalApiHub({
            storage: quotaStorage,
            now: () => 8_500,
            persistDebounceMs: 0,
        });

        await hub.ingestEvent(buildEvent('conv-1'), 1);
        await hub.ingestEvent(buildEvent('conv-2'), 1);
        await hub.flushPersist();

        const persisted = quotaStorage.backing[EXTERNAL_CACHE_STORAGE_KEY] as
            | { latestConversationId: string | null; records: Array<{ conversation_id: string }> }
            | undefined;

        expect(quotaStorage.writes).toBeGreaterThan(1);
        expect(persisted?.records).toHaveLength(1);
        expect(persisted?.latestConversationId).toBe('conv-2');
        expect(persisted?.records[0]?.conversation_id).toBe('conv-2');
    });
});
