import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
    createExternalApiHub,
    createInMemoryExternalEventStore,
    type ExternalPortLike,
} from '@/utils/external-api/background-hub';
import { EXTERNAL_API_VERSION, type ExternalInboundConversationEvent } from '@/utils/external-api/contracts';
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

const buildInboundEvent = (
    conversationId: string,
    type: ExternalInboundConversationEvent['type'] = 'conversation.ready',
): ExternalInboundConversationEvent => ({
    api: EXTERNAL_API_VERSION,
    type,
    event_id: `evt-${conversationId}-${type}`,
    ts: Date.now(),
    provider: 'chatgpt',
    conversation_id: conversationId,
    payload: buildConversation(conversationId),
    capture_meta: {
        captureSource: 'canonical_api',
        fidelity: 'high',
        completeness: 'complete',
    },
    content_hash: `hash:${conversationId}`,
    attempt_id: `attempt:${conversationId}`,
});

type FakePort = ExternalPortLike & {
    emitMessage: (message: unknown) => void;
    disconnectNow: () => void;
};

const createFakePort = (name: string): FakePort => {
    const disconnectHandlers = new Set<(port: ExternalPortLike) => void>();
    const messageHandlers = new Set<(message: unknown) => void>();
    const port: FakePort = {
        name,
        postMessage: mock(() => {}),
        onMessage: {
            addListener: (listener) => {
                messageHandlers.add(listener);
            },
            removeListener: (listener) => {
                messageHandlers.delete(listener);
            },
        },
        onDisconnect: {
            addListener: (listener) => {
                disconnectHandlers.add(listener);
            },
            removeListener: (listener) => {
                disconnectHandlers.delete(listener);
            },
        },
        disconnect: mock(() => {}),
        emitMessage: (message) => {
            for (const listener of messageHandlers) {
                listener(message);
            }
        },
        disconnectNow: () => {
            for (const listener of disconnectHandlers) {
                listener(port);
            }
        },
    };
    return port;
};

const flushAsyncTasks = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
};

const wait = async (durationMs: number) => {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
};

const collectEventsSince = async (hub: ReturnType<typeof createExternalApiHub>) => {
    const allEvents: Array<{ seq: number; conversation_id: string }> = [];
    let cursor = 0;
    while (true) {
        const response = await hub.handleExternalRequest({
            api: EXTERNAL_API_VERSION,
            type: 'events.getSince',
            cursor,
            limit: 200,
        });
        if (!response.ok || !('events' in response)) {
            throw new Error('expected getSince success response');
        }
        if (response.events.length === 0) {
            break;
        }
        for (const event of response.events) {
            allEvents.push({ seq: event.seq, conversation_id: event.conversation_id });
        }
        cursor = response.events[response.events.length - 1]?.seq ?? cursor;
    }
    return allEvents;
};

describe('background external api hub', () => {
    let now = 1_000;

    beforeEach(() => {
        now = 1_000;
    });

    it('should append with seq metadata and replay from cursor in strict order', async () => {
        const hub = createExternalApiHub({
            eventStore: createInMemoryExternalEventStore(),
            now: () => now,
        });

        await hub.ingestEvent(buildInboundEvent('conv-1'), 1);
        await hub.ingestEvent(buildInboundEvent('conv-2'), 2);
        await hub.ingestEvent(buildInboundEvent('conv-3'), 3);

        const port = createFakePort(EXTERNAL_API_VERSION);
        hub.addSubscriber(port, { senderExtensionId: 'extendo-id' });
        port.emitMessage({ type: 'subscribe', cursor: 1, consumer_role: 'delivery' });
        await flushAsyncTasks();

        expect(port.postMessage).toHaveBeenCalledTimes(2);
        expect(port.postMessage).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                type: 'events.batch',
                batch_start: 2,
                batch_end: 3,
                head_seq: 3,
                events: [
                    expect.objectContaining({ seq: 2, conversation_id: 'conv-2', created_at: expect.any(Number) }),
                    expect.objectContaining({ seq: 3, conversation_id: 'conv-3', created_at: expect.any(Number) }),
                ],
            }),
        );
        expect(port.postMessage).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                type: 'replay.complete',
                cursor: 1,
                head_seq: 3,
            }),
        );
    });

    it('should keep append durable when live broadcast fails', async () => {
        const hub = createExternalApiHub({
            eventStore: createInMemoryExternalEventStore(),
            now: () => now,
        });

        const badPort = createFakePort(EXTERNAL_API_VERSION);
        badPort.postMessage = mock(() => {
            throw new Error('port disconnected');
        });

        hub.addSubscriber(badPort, { senderExtensionId: 'extendo-id' });
        badPort.emitMessage({ type: 'subscribe', cursor: 0, consumer_role: 'delivery' });

        await hub.ingestEvent(buildInboundEvent('conv-crash'), 77);

        const response = await hub.handleExternalRequest({
            api: EXTERNAL_API_VERSION,
            type: 'events.getSince',
            cursor: 0,
            limit: 50,
        });

        expect(response).toMatchObject({ ok: true, head_seq: 1 });
        if (response.ok && 'events' in response) {
            expect(response.events).toHaveLength(1);
            expect(response.events[0]).toMatchObject({ seq: 1, conversation_id: 'conv-crash' });
        }
    });

    it('should return ordered batches for events.getSince', async () => {
        const hub = createExternalApiHub({
            eventStore: createInMemoryExternalEventStore(),
            now: () => now,
        });

        await hub.ingestEvent(buildInboundEvent('conv-1'), 1);
        await hub.ingestEvent(buildInboundEvent('conv-2'), 2);

        const response = await hub.handleExternalRequest({
            api: EXTERNAL_API_VERSION,
            type: 'events.getSince',
            cursor: 0,
            limit: 1,
        });

        expect(response).toMatchObject({ ok: true, head_seq: 2, format: 'original' });
        if (response.ok && 'events' in response) {
            expect(response.events).toHaveLength(1);
            expect(response.events[0]).toMatchObject({ seq: 1, conversation_id: 'conv-1' });
        }
    });

    it('should prune committed ranges while retaining uncommitted events', async () => {
        const hub = createExternalApiHub({
            eventStore: createInMemoryExternalEventStore(),
            now: () => now,
        });

        for (let index = 1; index <= 600; index += 1) {
            await hub.ingestEvent(buildInboundEvent(`conv-${index}`), index);
        }

        const port = createFakePort(EXTERNAL_API_VERSION);
        hub.addSubscriber(port, { senderExtensionId: 'extendo-id' });
        port.emitMessage({ type: 'subscribe', cursor: 0, consumer_role: 'delivery' });
        await flushAsyncTasks();

        port.emitMessage({ type: 'commit', up_to_seq: 550 });
        await flushAsyncTasks();

        const events = await collectEventsSince(hub);
        expect(events[0]?.seq).toBe(51);
        expect(events[events.length - 1]?.seq).toBe(600);
        expect(events.some((event) => event.seq === 551)).toBeTrue();
    });

    it('should reject commit authority for non-designated subscribers', async () => {
        const hub = createExternalApiHub({
            eventStore: createInMemoryExternalEventStore(),
            now: () => now,
        });

        for (let index = 1; index <= 600; index += 1) {
            await hub.ingestEvent(buildInboundEvent(`conv-${index}`), index);
        }

        const designatedPort = createFakePort(EXTERNAL_API_VERSION);
        hub.addSubscriber(designatedPort, { senderExtensionId: 'designated-ext' });
        designatedPort.emitMessage({ type: 'subscribe', cursor: 0, consumer_role: 'delivery' });
        await flushAsyncTasks();

        const otherPort = createFakePort(EXTERNAL_API_VERSION);
        hub.addSubscriber(otherPort, { senderExtensionId: 'other-ext' });
        otherPort.emitMessage({ type: 'subscribe', cursor: 0, consumer_role: 'delivery' });
        await flushAsyncTasks();

        otherPort.emitMessage({ type: 'commit', up_to_seq: 550 });
        await flushAsyncTasks();

        const beforeAuthorizedCommit = await collectEventsSince(hub);
        expect(beforeAuthorizedCommit[0]?.seq).toBe(1);

        designatedPort.emitMessage({ type: 'commit', up_to_seq: 550 });
        await flushAsyncTasks();

        const afterAuthorizedCommit = await collectEventsSince(hub);
        expect(afterAuthorizedCommit[0]?.seq).toBe(51);
    });

    it('should disconnect non-designated delivery subscribers before replay', async () => {
        const hub = createExternalApiHub({
            eventStore: createInMemoryExternalEventStore(),
            now: () => now,
        });

        await hub.ingestEvent(buildInboundEvent('conv-1'), 1);
        await hub.ingestEvent(buildInboundEvent('conv-2'), 2);

        const designatedPort = createFakePort(EXTERNAL_API_VERSION);
        hub.addSubscriber(designatedPort, { senderExtensionId: 'designated-ext' });
        designatedPort.emitMessage({ type: 'subscribe', cursor: 0, consumer_role: 'delivery' });
        await flushAsyncTasks();

        const nonDesignatedPort = createFakePort(EXTERNAL_API_VERSION);
        hub.addSubscriber(nonDesignatedPort, { senderExtensionId: 'other-ext' });
        nonDesignatedPort.emitMessage({ type: 'subscribe', cursor: 0, consumer_role: 'delivery' });
        await flushAsyncTasks();

        expect(nonDesignatedPort.disconnect).toHaveBeenCalledTimes(1);
        expect(nonDesignatedPort.postMessage).not.toHaveBeenCalled();
    });

    it('should send wake signal when delivery consumer is offline and rate limit wake bursts', async () => {
        const wakeCalls: Array<{ extensionId: string; message: unknown }> = [];
        const hub = createExternalApiHub({
            eventStore: createInMemoryExternalEventStore(),
            now: () => now,
            wakeThrottleMs: 3_000,
            sendWakeMessage: async (extensionId, message) => {
                wakeCalls.push({ extensionId, message });
            },
        });

        const port = createFakePort(EXTERNAL_API_VERSION);
        hub.addSubscriber(port, { senderExtensionId: 'delivery-ext' });
        port.emitMessage({ type: 'subscribe', cursor: 0, consumer_role: 'delivery' });
        await flushAsyncTasks();
        port.disconnectNow();

        await hub.ingestEvent(buildInboundEvent('conv-1'), 1);
        expect(wakeCalls).toHaveLength(1);
        expect(wakeCalls[0]).toMatchObject({
            extensionId: 'delivery-ext',
            message: expect.objectContaining({ type: 'BLACKIYA_WAKE', head_seq: 1 }),
        });

        now += 1_000;
        await hub.ingestEvent(buildInboundEvent('conv-2'), 2);
        expect(wakeCalls).toHaveLength(1);

        now += 3_100;
        await hub.ingestEvent(buildInboundEvent('conv-3'), 3);
        expect(wakeCalls).toHaveLength(2);
        expect(wakeCalls[1]).toMatchObject({
            extensionId: 'delivery-ext',
            message: expect.objectContaining({ type: 'BLACKIYA_WAKE', head_seq: 3 }),
        });
    });

    it('should still wake designated consumer when non-designated subscriber is connected', async () => {
        const wakeCalls: Array<{ extensionId: string; message: unknown }> = [];
        const hub = createExternalApiHub({
            eventStore: createInMemoryExternalEventStore(),
            now: () => now,
            wakeThrottleMs: 3_000,
            sendWakeMessage: async (extensionId, message) => {
                wakeCalls.push({ extensionId, message });
            },
        });

        const designatedPort = createFakePort(EXTERNAL_API_VERSION);
        hub.addSubscriber(designatedPort, { senderExtensionId: 'delivery-ext' });
        designatedPort.emitMessage({ type: 'subscribe', cursor: 0, consumer_role: 'delivery' });
        await flushAsyncTasks();
        designatedPort.disconnectNow();

        const nonDesignatedPort = createFakePort(EXTERNAL_API_VERSION);
        hub.addSubscriber(nonDesignatedPort, { senderExtensionId: 'other-ext' });
        nonDesignatedPort.emitMessage({ type: 'subscribe', cursor: 0, consumer_role: 'delivery' });
        await flushAsyncTasks();

        await hub.ingestEvent(buildInboundEvent('conv-wake-designated'), 1);

        expect(nonDesignatedPort.disconnect).toHaveBeenCalledTimes(1);
        expect(wakeCalls).toHaveLength(1);
        expect(wakeCalls[0]).toMatchObject({
            extensionId: 'delivery-ext',
            message: expect.objectContaining({ type: 'BLACKIYA_WAKE', head_seq: 1 }),
        });
    });

    it('should rate-limit wake bursts under parallel ingests', async () => {
        const wakeCalls: Array<{ extensionId: string; message: unknown }> = [];
        const hub = createExternalApiHub({
            eventStore: createInMemoryExternalEventStore(),
            now: () => now,
            wakeThrottleMs: 3_000,
            sendWakeMessage: async (extensionId, message) => {
                wakeCalls.push({ extensionId, message });
            },
        });

        const port = createFakePort(EXTERNAL_API_VERSION);
        hub.addSubscriber(port, { senderExtensionId: 'delivery-ext' });
        port.emitMessage({ type: 'subscribe', cursor: 0, consumer_role: 'delivery' });
        await flushAsyncTasks();
        port.disconnectNow();

        await Promise.all([
            hub.ingestEvent(buildInboundEvent('conv-race-1'), 1),
            hub.ingestEvent(buildInboundEvent('conv-race-2'), 2),
            hub.ingestEvent(buildInboundEvent('conv-race-3'), 3),
        ]);

        expect(wakeCalls).toHaveLength(1);
        expect(wakeCalls[0]).toMatchObject({
            extensionId: 'delivery-ext',
            message: expect.objectContaining({ type: 'BLACKIYA_WAKE' }),
        });
    });

    it('should retry wake quickly when wake send fails before throttle window', async () => {
        let sendAttempts = 0;
        const wakeCalls: Array<{ extensionId: string; message: unknown }> = [];
        const hub = createExternalApiHub({
            eventStore: createInMemoryExternalEventStore(),
            now: () => now,
            wakeThrottleMs: 3_000,
            sendWakeMessage: async (extensionId, message) => {
                sendAttempts += 1;
                wakeCalls.push({ extensionId, message });
                if (sendAttempts === 1) {
                    throw new Error('transient wake failure');
                }
            },
        });

        const port = createFakePort(EXTERNAL_API_VERSION);
        hub.addSubscriber(port, { senderExtensionId: 'delivery-ext' });
        port.emitMessage({ type: 'subscribe', cursor: 0, consumer_role: 'delivery' });
        await flushAsyncTasks();
        port.disconnectNow();

        await hub.ingestEvent(buildInboundEvent('conv-wake-1'), 1);
        now += 1_000;
        await hub.ingestEvent(buildInboundEvent('conv-wake-2'), 2);

        expect(wakeCalls).toHaveLength(2);
        expect(wakeCalls[0]).toMatchObject({
            extensionId: 'delivery-ext',
            message: expect.objectContaining({ type: 'BLACKIYA_WAKE', head_seq: 1 }),
        });
        expect(wakeCalls[1]).toMatchObject({
            extensionId: 'delivery-ext',
            message: expect.objectContaining({ type: 'BLACKIYA_WAKE', head_seq: 2 }),
        });
    });

    it('should reject commits that exceed delivered watermark during replay race', async () => {
        const baseStore = createInMemoryExternalEventStore({
            keepCommittedDiagnostics: 0,
        });
        const delayedStore = {
            ...baseStore,
            getSince: async (cursor: number, limit: number) => {
                await wait(10);
                return baseStore.getSince(cursor, limit);
            },
        };
        const hub = createExternalApiHub({
            eventStore: delayedStore,
            now: () => now,
        });

        for (let index = 1; index <= 10; index += 1) {
            await hub.ingestEvent(buildInboundEvent(`conv-watermark-${index}`), index);
        }

        const port = createFakePort(EXTERNAL_API_VERSION);
        hub.addSubscriber(port, { senderExtensionId: 'delivery-ext' });
        port.emitMessage({ type: 'subscribe', cursor: 5, consumer_role: 'delivery' });
        port.emitMessage({ type: 'commit', up_to_seq: 10 });

        await wait(40);
        const events = await collectEventsSince(hub);
        expect(events[0]?.seq).toBe(1);
        expect(events[events.length - 1]?.seq).toBe(10);
    });

    it('should retry initialization after transient init failure', async () => {
        const baseStore = createInMemoryExternalEventStore();
        let initCalls = 0;
        const flakyStore = {
            ...baseStore,
            init: async () => {
                initCalls += 1;
                if (initCalls === 1) {
                    throw new Error('transient init failure');
                }
            },
        };

        const hub = createExternalApiHub({
            eventStore: flakyStore,
            now: () => now,
        });

        await expect(hub.ingestEvent(buildInboundEvent('conv-init-1'), 1)).rejects.toThrow('transient init failure');
        await expect(hub.ingestEvent(buildInboundEvent('conv-init-2'), 1)).resolves.toBeDefined();
        expect(initCalls).toBe(2);
    });
});
