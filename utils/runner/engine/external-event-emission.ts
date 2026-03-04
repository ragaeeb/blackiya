import { browser } from 'wxt/browser';
import { logger } from '@/utils/logger';
import { evaluateReadinessForData, shouldBlockActionsForGeneration } from '@/utils/runner/engine/core-utils';
import type { EngineCtx } from '@/utils/runner/engine/types';
import {
    buildExternalInternalEventMessage,
    markExternalConversationEventDispatched,
    maybeBuildExternalConversationEvent,
} from '@/utils/runner/external-event-dispatch';
import type { ExportMeta, ReadinessDecision } from '@/utils/sfe/types';
import {
    deriveConversationTitleFromFirstUserMessage,
    resolveConversationTitleByPrecedence,
} from '@/utils/title-resolver';
import type { ConversationData } from '@/utils/types';

const EXTERNAL_EVENT_RETRY_DELAYS_MS = [20, 100, 300] as const;
const EXTERNAL_EVENT_SEND_TIMEOUT_MS = 3_000;

type ExternalDeliveryResponse = {
    success?: unknown;
    delivery?: {
        subscriberCount?: unknown;
        delivered?: unknown;
        dropped?: unknown;
    };
    error?: unknown;
};

const extractDeliveryStats = (response: ExternalDeliveryResponse | undefined) =>
    typeof response?.delivery?.subscriberCount === 'number' &&
    typeof response.delivery.delivered === 'number' &&
    typeof response.delivery.dropped === 'number'
        ? {
              listenerCount: response.delivery.subscriberCount,
              delivered: response.delivery.delivered,
              dropped: response.delivery.dropped,
          }
        : null;

const resolveSendTimeoutMs = (ctx: EngineCtx): number => {
    const candidate = (ctx as { externalEventSendTimeoutMs?: unknown }).externalEventSendTimeoutMs;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
        return Math.floor(candidate);
    }
    return EXTERNAL_EVENT_SEND_TIMEOUT_MS;
};

const sendMessageWithTimeout = (event: ReturnType<typeof buildExternalInternalEventMessage>, timeoutMs: number) => {
    return new Promise<unknown>((resolve, reject) => {
        const timeoutId = globalThis.setTimeout(() => {
            reject(new Error(`External event send timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        browser.runtime
            .sendMessage(event)
            .then((response) => {
                clearTimeout(timeoutId);
                resolve(response);
            })
            .catch((error) => {
                clearTimeout(timeoutId);
                reject(error);
            });
    });
};

const applyTitleFallbackForExternalEvent = (ctx: EngineCtx, conversationId: string, data: ConversationData) => {
    const adapter = ctx.currentAdapter;
    if (!adapter) {
        return;
    }
    const streamTitle = ctx.streamResolvedTitles?.get(conversationId) ?? null;
    const activeConversationId =
        typeof adapter.extractConversationId === 'function'
            ? adapter.extractConversationId(window.location.href)
            : null;
    const domTitle =
        typeof adapter.extractTitleFromDom === 'function' && activeConversationId === conversationId
            ? adapter.extractTitleFromDom()
            : null;
    const promptDerivedTitle = deriveConversationTitleFromFirstUserMessage(data);
    const titleDecision = resolveConversationTitleByPrecedence({
        streamTitle,
        cachedTitle: data.title ?? null,
        domTitle,
        firstUserMessageTitle: promptDerivedTitle,
        fallbackTitle: data.title ?? 'Conversation',
        platformDefaultTitles: Array.isArray(adapter.defaultTitles) ? adapter.defaultTitles : [],
    });
    const currentTitle = (data.title ?? '').trim();
    if (titleDecision.title === currentTitle) {
        return;
    }
    logger.info('External event title fallback applied', {
        conversationId,
        adapter: adapter.name,
        streamTitle,
        domTitle: domTitle ?? null,
        oldTitle: currentTitle || null,
        newTitle: titleDecision.title,
        source: titleDecision.source,
    });
    data.title = titleDecision.title;
};

export const emitExternalConversationEvent = (
    ctx: EngineCtx,
    args: {
        conversationId: string;
        data: ConversationData;
        readinessMode: ReadinessDecision['mode'];
        captureMeta: ExportMeta;
        attemptId: string | null;
        allowWhenActionsBlocked?: boolean;
    },
) => {
    const shouldBlockActions = args.allowWhenActionsBlocked
        ? false
        : shouldBlockActionsForGeneration(ctx, args.conversationId);
    applyTitleFallbackForExternalEvent(ctx, args.conversationId, args.data);

    const event = maybeBuildExternalConversationEvent({
        conversationId: args.conversationId,
        data: args.data,
        providerName: ctx.currentAdapter?.name,
        readinessMode: args.readinessMode,
        captureMeta: args.captureMeta,
        attemptId: args.attemptId,
        shouldBlockActions,
        evaluateReadinessForData: (data) => evaluateReadinessForData(ctx, data),
        state: ctx.externalEventDispatchState,
    });
    if (!event) {
        return;
    }
    logger.debug('External event build attempt', {
        conversationId: args.conversationId,
        readinessMode: args.readinessMode,
        captureSource: args.captureMeta.captureSource,
        fidelity: args.captureMeta.fidelity,
        completeness: args.captureMeta.completeness,
        attemptId: args.attemptId,
        shouldBlockActions,
        allowWhenActionsBlocked: !!args.allowWhenActionsBlocked,
    });
    logger.debug('External event send start', {
        conversationId: event.conversation_id,
        eventType: event.type,
        eventId: event.event_id,
        contentHash: event.content_hash,
    });
    const previousDispatchState = ctx.externalEventDispatchState.byConversation.get(event.conversation_id);
    const sendTimeoutMs = resolveSendTimeoutMs(ctx);
    markExternalConversationEventDispatched(
        ctx.externalEventDispatchState,
        event.conversation_id,
        event.attempt_id,
        event.content_hash,
        event.payload,
    );
    const restoreDispatchState = () => {
        if (previousDispatchState) {
            ctx.externalEventDispatchState.byConversation.set(event.conversation_id, previousDispatchState);
            return;
        }
        ctx.externalEventDispatchState.byConversation.delete(event.conversation_id);
    };

    const queueRetry = (attemptIndex: number, error: unknown, delivery: ReturnType<typeof extractDeliveryStats>) => {
        const delayMs = EXTERNAL_EVENT_RETRY_DELAYS_MS[attemptIndex];
        if (delayMs === undefined) {
            return false;
        }
        logger.debug('External event send retry scheduled', {
            conversationId: event.conversation_id,
            type: event.type,
            eventId: event.event_id,
            attempt: attemptIndex + 2,
            delayMs,
            error,
            subscriberCount: delivery?.listenerCount ?? null,
            delivered: delivery?.delivered ?? null,
            dropped: delivery?.dropped ?? null,
        });
        const retryTimer = globalThis.setTimeout(() => {
            void send(attemptIndex + 1);
        }, delayMs);
        if (Array.isArray((ctx as Partial<EngineCtx>).retryTimeoutIds)) {
            ctx.retryTimeoutIds.push(retryTimer as unknown as number);
        }
        return true;
    };

    const send = (attemptIndex: number) => {
        return sendMessageWithTimeout(buildExternalInternalEventMessage(event), sendTimeoutMs)
            .then((response) => {
                const typed = response as ExternalDeliveryResponse | undefined;
                const delivery = extractDeliveryStats(typed);
                if (typed?.success !== true) {
                    const ackError = {
                        message: 'External event rejected by background hub',
                        response: typed ?? null,
                    };
                    ctx.recordTabDebugExternalEvent({
                        event,
                        status: 'failed',
                        error: ackError,
                        delivery,
                    });
                    logger.debug('External event send negative ACK', {
                        conversationId: event.conversation_id,
                        type: event.type,
                        eventId: event.event_id,
                        error: ackError,
                        subscriberCount: delivery?.listenerCount ?? null,
                        delivered: delivery?.delivered ?? null,
                        dropped: delivery?.dropped ?? null,
                    });
                    const scheduled = queueRetry(attemptIndex, ackError, delivery);
                    if (!scheduled) {
                        restoreDispatchState();
                    }
                    return;
                }
                ctx.recordTabDebugExternalEvent({
                    event,
                    status: 'sent',
                    delivery,
                });
                logger.debug('External event send success', {
                    conversationId: event.conversation_id,
                    eventType: event.type,
                    eventId: event.event_id,
                    contentHash: event.content_hash,
                    subscriberCount: delivery?.listenerCount ?? null,
                    delivered: delivery?.delivered ?? null,
                    dropped: delivery?.dropped ?? null,
                });
            })
            .catch((error) => {
                ctx.recordTabDebugExternalEvent({
                    event,
                    status: 'failed',
                    error,
                });
                logger.warn('External event send failed', {
                    conversationId: event.conversation_id,
                    type: event.type,
                    eventId: event.event_id,
                    error,
                });
                const scheduled = queueRetry(attemptIndex, error, null);
                if (!scheduled) {
                    restoreDispatchState();
                }
            });
    };

    void send(0);
};
