import { browser } from 'wxt/browser';
import { logger } from '@/utils/logger';
import { runPayloadQualityGate } from '@/utils/payload-quality-gate';
import { cancelQualityToast, dismissPayloadQualityToast, scheduleQualityToast } from '@/utils/payload-quality-toast';
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
        forceEmit?: boolean;
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
        forceEmit: args.forceEmit,
        evaluateReadinessForData: (data) => evaluateReadinessForData(ctx, data),
        state: ctx.externalEventDispatchState,
    });
    if (!event) {
        return;
    }

    // Run payload quality gate — non-blocking, logs diagnostics on failure
    const qualityResult = runPayloadQualityGate(
        args.conversationId,
        ctx.currentAdapter?.name ?? 'Unknown',
        event.type,
        args.captureMeta,
        args.data,
    );

    // Show dismissible toast only after a delay — gives conversation.updated time to arrive
    // with richer data. Cancel the pending toast if quality passes on a subsequent event.
    if (!qualityResult.passed && qualityResult.issues.includes('missing_model')) {
        scheduleQualityToast(args.conversationId, ctx.currentAdapter?.name ?? 'Unknown', qualityResult);
    } else if (qualityResult.passed) {
        cancelQualityToast(args.conversationId);
        dismissPayloadQualityToast();
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
        forceEmit: args.forceEmit === true,
        qualityPassed: qualityResult.passed,
        qualityIssues: qualityResult.issues.length > 0 ? qualityResult.issues : undefined,
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
    const optimisticDispatchState = ctx.externalEventDispatchState.byConversation.get(event.conversation_id);
    const isSuperseded = () =>
        ctx.externalEventDispatchState.byConversation.get(event.conversation_id) !== optimisticDispatchState;
    const restoreDispatchState = () => {
        if (previousDispatchState) {
            ctx.externalEventDispatchState.byConversation.set(event.conversation_id, previousDispatchState);
            return;
        }
        ctx.externalEventDispatchState.byConversation.delete(event.conversation_id);
    };

    const queueRetry = (
        attemptIndex: number,
        error: unknown,
        delivery: ReturnType<typeof extractDeliveryStats>,
    ): 'scheduled' | 'exhausted' | 'superseded' => {
        if (isSuperseded()) {
            logger.debug('External event retry canceled because dispatch state was superseded', {
                conversationId: event.conversation_id,
                type: event.type,
                eventId: event.event_id,
                attempt: attemptIndex + 2,
            });
            return 'superseded';
        }
        const delayMs = EXTERNAL_EVENT_RETRY_DELAYS_MS[attemptIndex];
        if (delayMs === undefined) {
            return 'exhausted';
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
            if (isSuperseded()) {
                logger.debug('External event retry skipped after supersession', {
                    conversationId: event.conversation_id,
                    type: event.type,
                    eventId: event.event_id,
                    attempt: attemptIndex + 2,
                });
                return;
            }
            void send(attemptIndex + 1);
        }, delayMs);
        if (Array.isArray((ctx as Partial<EngineCtx>).retryTimeoutIds)) {
            ctx.retryTimeoutIds.push(retryTimer as unknown as number);
        }
        return 'scheduled';
    };

    const send = (attemptIndex: number) => {
        if (isSuperseded()) {
            logger.debug('External event send skipped because dispatch state was superseded', {
                conversationId: event.conversation_id,
                type: event.type,
                eventId: event.event_id,
                attempt: attemptIndex + 1,
            });
            return Promise.resolve();
        }
        return sendMessageWithTimeout(buildExternalInternalEventMessage(event), sendTimeoutMs)
            .then((response) => {
                const typed = response as ExternalDeliveryResponse | undefined;
                const delivery = extractDeliveryStats(typed);
                if (typed?.success !== true) {
                    const ackError = {
                        message: 'External event rejected by background hub',
                        response: typed ?? null,
                    };
                    logger.debug('External event send negative ACK', {
                        conversationId: event.conversation_id,
                        type: event.type,
                        eventId: event.event_id,
                        error: ackError,
                        subscriberCount: delivery?.listenerCount ?? null,
                        delivered: delivery?.delivered ?? null,
                        dropped: delivery?.dropped ?? null,
                    });
                    const retryState = queueRetry(attemptIndex, ackError, delivery);
                    if (retryState === 'exhausted') {
                        restoreDispatchState();
                    }
                    return;
                }
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
                logger.warn('External event send failed', {
                    conversationId: event.conversation_id,
                    type: event.type,
                    eventId: event.event_id,
                    error,
                });
                const retryState = queueRetry(attemptIndex, error, null);
                if (retryState === 'exhausted') {
                    restoreDispatchState();
                }
            });
    };

    void send(0);
};
