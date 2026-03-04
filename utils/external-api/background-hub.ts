import {
    asTabId,
    buildFailureResponse,
    buildSuccessResponse,
    clampBatchSize,
    DEFAULT_BATCH_SIZE,
    DEFAULT_WAKE_THROTTLE_MS,
    MAX_BATCH_SIZE,
    toFormat,
} from '@/utils/external-api/background-hub-helpers';
import type {
    ExternalEventDeliveryStats,
    ExternalEventStore,
    ExternalPortLike,
} from '@/utils/external-api/background-hub-types';
import type {
    ExternalCommitMessage,
    ExternalConversationEvent,
    ExternalHealthSuccessResponse,
    ExternalInboundConversationEvent,
    ExternalPortInboundMessage,
    ExternalPortOutboundMessage,
    ExternalReplayCompleteMessage,
    ExternalResponse,
    ExternalSubscribeMessage,
    ExternalWakeMessage,
} from '@/utils/external-api/contracts';
import {
    EXTERNAL_API_VERSION,
    EXTERNAL_EVENTS_PORT_NAME,
    isExternalCommitMessage,
    isExternalPortInboundMessage,
    isExternalRequest,
    isExternalSubscribeMessage,
} from '@/utils/external-api/contracts';
import {
    createIndexedDbExternalEventStore,
    createInMemoryExternalEventStore,
} from '@/utils/external-api/external-event-store';
import { EXPORT_FORMAT } from '@/utils/settings';

export type {
    CachedConversationRecord,
    ExternalEventDeliveryStats,
    ExternalEventStore,
    ExternalPortLike,
} from '@/utils/external-api/background-hub-types';
export { createIndexedDbExternalEventStore, createInMemoryExternalEventStore };

type ExternalApiHubDeps = {
    eventStore?: ExternalEventStore;
    now?: () => number;
    defaultBatchSize?: number;
    maxReplayBatchSize?: number;
    wakeThrottleMs?: number;
    sendWakeMessage?: (extensionId: string, message: ExternalWakeMessage) => Promise<void>;
    logger?: {
        debug?: (message: string, data?: unknown) => void;
        warn: (message: string, data?: unknown) => void;
    };
};

type SubscriberState = {
    senderExtensionId: string | null;
    subscribed: boolean;
    cursor: number;
    maxBatch: number;
    replayInFlight: boolean;
    lastDeliveredSeq: number;
};

type ReplayBatch = {
    events: Awaited<ReturnType<ExternalEventStore['getSince']>>;
    headSeq: number;
    batchStart: number;
    batchEnd: number;
};

export const createExternalApiHub = (deps: ExternalApiHubDeps) => {
    const now = deps.now ?? (() => Date.now());
    const eventStore = deps.eventStore ?? createIndexedDbExternalEventStore({ now });
    const defaultBatchSize = clampBatchSize(deps.defaultBatchSize, DEFAULT_BATCH_SIZE);
    const maxReplayBatchSize = clampBatchSize(deps.maxReplayBatchSize, MAX_BATCH_SIZE);
    const wakeThrottleMs = Math.max(0, deps.wakeThrottleMs ?? DEFAULT_WAKE_THROTTLE_MS);
    const sendWakeMessage = deps.sendWakeMessage ?? (async () => {});

    const subscribers = new Map<ExternalPortLike, SubscriberState>();

    let initialized = false;
    let initializePromise: Promise<void> | null = null;
    let wakeGate: Promise<void> = Promise.resolve();

    const ensureHydrated = async () => {
        if (initialized) {
            return;
        }
        if (!initializePromise) {
            initializePromise = eventStore
                .init()
                .then(() => {
                    initialized = true;
                })
                .catch((error) => {
                    deps.logger?.warn('Failed to initialize external event store', { error });
                    throw error;
                })
                .finally(() => {
                    initializePromise = null;
                });
        }
        await initializePromise;
    };

    const removeSubscriber = (port: ExternalPortLike) => {
        subscribers.delete(port);
    };

    const hasOnlineDeliverySubscriber = async () => {
        const designatedConsumerId = await eventStore.getDeliveryConsumerId();
        if (!designatedConsumerId) {
            return false;
        }
        for (const state of subscribers.values()) {
            if (!state.subscribed) {
                continue;
            }
            if (state.senderExtensionId === designatedConsumerId) {
                return true;
            }
        }
        return false;
    };

    const maybeSendWake = async (headSeq: number) => {
        const run = async () => {
            const designatedConsumerId = await eventStore.getDeliveryConsumerId();
            if (!designatedConsumerId) {
                return;
            }
            if (await hasOnlineDeliverySubscriber()) {
                return;
            }

            const nowTs = now();
            const lastWakeSentAt = await eventStore.getLastWakeSentAt();
            if (lastWakeSentAt > 0 && nowTs - lastWakeSentAt < wakeThrottleMs) {
                return;
            }

            try {
                await sendWakeMessage(designatedConsumerId, {
                    type: 'BLACKIYA_WAKE',
                    head_seq: headSeq,
                    ts: nowTs,
                });
                await eventStore.setLastWakeSentAt(nowTs);
            } catch (error) {
                deps.logger?.warn('Failed to send wake signal to delivery consumer', {
                    designatedConsumerId,
                    error,
                });
            }
        };
        wakeGate = wakeGate.then(run, run);
        await wakeGate;
    };

    const broadcastLiveEvent = async (event: ExternalConversationEvent): Promise<ExternalEventDeliveryStats> => {
        if (subscribers.size === 0) {
            return {
                subscriberCount: 0,
                delivered: 0,
                dropped: 0,
                designatedDelivered: false,
            };
        }

        const designatedConsumerId = await eventStore.getDeliveryConsumerId();
        let delivered = 0;
        let dropped = 0;
        let designatedDelivered = false;

        for (const [port, state] of [...subscribers.entries()]) {
            if (!state.subscribed) {
                continue;
            }
            try {
                port.postMessage(event satisfies ExternalPortOutboundMessage);
                state.lastDeliveredSeq = Math.max(state.lastDeliveredSeq, event.seq);
                delivered += 1;
                if (designatedConsumerId && state.senderExtensionId === designatedConsumerId) {
                    designatedDelivered = true;
                }
            } catch {
                subscribers.delete(port);
                dropped += 1;
            }
        }

        return {
            subscriberCount: subscribers.size,
            delivered,
            dropped,
            designatedDelivered,
        };
    };

    const readReplayBatch = async (cursor: number, replayBatchSize: number): Promise<ReplayBatch | null> => {
        const events = await eventStore.getSince(cursor, replayBatchSize);
        if (events.length === 0) {
            return null;
        }
        const headSeq = await eventStore.getHeadSeq();
        const batchStart = events[0]?.seq ?? cursor;
        const batchEnd = events[events.length - 1]?.seq ?? cursor;
        return {
            events,
            headSeq,
            batchStart,
            batchEnd,
        };
    };

    const postReplayBatch = (port: ExternalPortLike, batch: ReplayBatch) => {
        port.postMessage({
            type: 'events.batch',
            events: batch.events,
            head_seq: batch.headSeq,
            batch_start: batch.batchStart,
            batch_end: batch.batchEnd,
        } satisfies ExternalPortOutboundMessage);
        const state = subscribers.get(port);
        if (state) {
            state.lastDeliveredSeq = Math.max(state.lastDeliveredSeq, batch.batchEnd);
        }
    };

    const streamReplayBatches = async (port: ExternalPortLike, replayCursor: number, replayBatchSize: number) => {
        let cursor = replayCursor;
        while (subscribers.has(port)) {
            const batch = await readReplayBatch(cursor, replayBatchSize);
            if (!batch) {
                break;
            }
            postReplayBatch(port, batch);
            cursor = batch.batchEnd;
        }
    };

    const postReplayCompleteIfConnected = async (port: ExternalPortLike, replayCursor: number) => {
        if (!subscribers.has(port)) {
            return;
        }
        const completeMessage: ExternalReplayCompleteMessage = {
            type: 'replay.complete',
            cursor: replayCursor,
            head_seq: await eventStore.getHeadSeq(),
        };
        port.postMessage(completeMessage satisfies ExternalPortOutboundMessage);
    };

    const replaySinceCursor = async (port: ExternalPortLike, subscribeMessage: ExternalSubscribeMessage) => {
        const state = subscribers.get(port);
        if (!state || state.replayInFlight) {
            return;
        }

        state.replayInFlight = true;
        const replayCursor = Math.max(0, Math.floor(subscribeMessage.cursor));
        const replayBatchSize = Math.min(state.maxBatch, maxReplayBatchSize);

        try {
            await streamReplayBatches(port, replayCursor, replayBatchSize);
            await postReplayCompleteIfConnected(port, replayCursor);
        } catch {
            removeSubscriber(port);
        } finally {
            const latestState = subscribers.get(port);
            if (latestState) {
                latestState.replayInFlight = false;
            }
        }
    };

    const disconnectSubscriber = (port: ExternalPortLike) => {
        removeSubscriber(port);
        try {
            port.disconnect?.();
        } catch {}
    };

    const authorizeDeliverySubscription = async (
        port: ExternalPortLike,
        state: SubscriberState,
        message: ExternalSubscribeMessage,
    ): Promise<boolean> => {
        if (message.consumer_role !== 'delivery') {
            return true;
        }
        if (!state.senderExtensionId) {
            deps.logger?.warn('External hub subscribe rejected: missing senderExtensionId', {
                consumerRole: message.consumer_role,
            });
            disconnectSubscriber(port);
            return false;
        }

        const result = await eventStore.ensureDeliveryConsumer(state.senderExtensionId);
        if (!result.authorized) {
            deps.logger?.warn('External hub subscribe from non-designated delivery consumer', {
                senderExtensionId: state.senderExtensionId,
                designatedConsumerId: result.designatedConsumerId,
            });
            disconnectSubscriber(port);
            return false;
        }

        return true;
    };

    const handleSubscribe = async (port: ExternalPortLike, message: ExternalSubscribeMessage) => {
        const state = subscribers.get(port);
        if (!state) {
            return;
        }

        const nextCursor = Math.max(0, Math.floor(message.cursor));
        const nextMaxBatch = clampBatchSize(message.max_batch, defaultBatchSize);

        const authorized = await authorizeDeliverySubscription(port, state, message);
        if (!authorized) {
            return;
        }

        state.subscribed = true;
        state.cursor = nextCursor;
        state.maxBatch = nextMaxBatch;
        state.lastDeliveredSeq = Math.max(state.lastDeliveredSeq, nextCursor);

        await replaySinceCursor(port, message);
    };

    const handleCommit = async (port: ExternalPortLike, message: ExternalCommitMessage) => {
        const state = subscribers.get(port);
        if (!state?.senderExtensionId) {
            return;
        }

        const requestedUpToSeq = Math.max(0, Math.floor(message.up_to_seq));
        if (requestedUpToSeq > state.lastDeliveredSeq) {
            deps.logger?.warn('External hub commit exceeds delivered watermark', {
                senderExtensionId: state.senderExtensionId,
                upToSeq: requestedUpToSeq,
                lastDeliveredSeq: state.lastDeliveredSeq,
            });
            return;
        }

        const result = await eventStore.commit(state.senderExtensionId, requestedUpToSeq);
        if (!result.authorized) {
            deps.logger?.warn('External hub commit rejected for non-designated consumer', {
                senderExtensionId: state.senderExtensionId,
                upToSeq: requestedUpToSeq,
            });
            return;
        }

        const pruneResult = await eventStore.prune();
        if (pruneResult.blockedByUncommitted) {
            deps.logger?.warn('External hub prune blocked by uncommitted backlog', {
                totalEvents: pruneResult.total,
            });
        }
    };

    const handlePortInboundMessage = async (port: ExternalPortLike, message: ExternalPortInboundMessage) => {
        await ensureHydrated();

        if (isExternalSubscribeMessage(message)) {
            await handleSubscribe(port, message);
            return;
        }
        if (isExternalCommitMessage(message)) {
            await handleCommit(port, message);
        }
    };

    const addSubscriber = (port: ExternalPortLike, context?: { senderExtensionId?: string | null }): boolean => {
        if (port.name !== EXTERNAL_EVENTS_PORT_NAME) {
            deps.logger?.warn('External hub rejected subscriber with invalid port name', { portName: port.name });
            try {
                port.disconnect?.();
            } catch {}
            return false;
        }

        const state: SubscriberState = {
            senderExtensionId: context?.senderExtensionId ?? null,
            subscribed: false,
            cursor: 0,
            maxBatch: defaultBatchSize,
            replayInFlight: false,
            lastDeliveredSeq: 0,
        };

        subscribers.set(port, state);

        const disconnectHandler = () => {
            removeSubscriber(port);
            port.onDisconnect.removeListener?.(disconnectHandler);
            if (port.onMessage && onMessageHandler) {
                port.onMessage.removeListener?.(onMessageHandler);
            }
        };

        const onMessageHandler = (message: unknown) => {
            if (!isExternalPortInboundMessage(message)) {
                return;
            }
            void handlePortInboundMessage(port, message).catch((error) => {
                deps.logger?.warn('External hub failed to process inbound port message', {
                    error,
                    senderExtensionId: state.senderExtensionId,
                    messageType: message.type,
                });
            });
        };

        if (port.onMessage) {
            port.onMessage.addListener(onMessageHandler);
        }
        port.onDisconnect.addListener(disconnectHandler);

        return true;
    };

    const ingestEvent = async (event: ExternalInboundConversationEvent, senderTabId?: number) => {
        await ensureHydrated();

        const resolvedTabId = event.tab_id ?? asTabId(senderTabId);
        const normalizedEvent =
            resolvedTabId === undefined
                ? event
                : {
                      ...event,
                      tab_id: resolvedTabId,
                  };

        const appendedEvent = await eventStore.append(normalizedEvent);
        const deliveryStats = await broadcastLiveEvent(appendedEvent);
        if (!deliveryStats.designatedDelivered) {
            await maybeSendWake(appendedEvent.seq);
        }

        return deliveryStats;
    };

    const handleExternalRequest = async (request: unknown): Promise<ExternalResponse> => {
        await ensureHydrated();
        if (!isExternalRequest(request)) {
            return buildFailureResponse(now, 'INVALID_REQUEST', 'Invalid external API request');
        }

        if (request.type === 'health.ping') {
            const response: ExternalHealthSuccessResponse = {
                ok: true,
                api: EXTERNAL_API_VERSION,
                ts: now(),
            };
            return response;
        }

        if (request.type === 'events.getSince') {
            const limit = clampBatchSize(request.limit, defaultBatchSize);
            const events = await eventStore.getSince(Math.max(0, Math.floor(request.cursor)), limit);
            return {
                ok: true,
                api: EXTERNAL_API_VERSION,
                ts: now(),
                format: EXPORT_FORMAT.ORIGINAL,
                head_seq: await eventStore.getHeadSeq(),
                events,
            };
        }

        if (request.type === 'conversation.getLatest') {
            const record = await eventStore.getLatest(request.tab_id);
            if (!record) {
                return buildFailureResponse(now, 'UNAVAILABLE', 'No conversation data available');
            }
            return buildSuccessResponse(record, toFormat(request.format), now);
        }

        const record = await eventStore.getByConversationId(request.conversation_id);
        if (!record) {
            return buildFailureResponse(now, 'NOT_FOUND', 'Conversation not found');
        }
        return buildSuccessResponse(record, toFormat(request.format), now);
    };

    return {
        addSubscriber,
        removeSubscriber,
        ingestEvent,
        handleExternalRequest,
        ensureHydrated,
        flushPersist: async () => {},
    };
};
