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

const applyTitleFallbackForExternalEvent = (ctx: EngineCtx, conversationId: string, data: ConversationData) => {
    const adapter = ctx.currentAdapter;
    if (!adapter?.defaultTitles) {
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
        platformDefaultTitles: adapter.defaultTitles,
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
    void browser.runtime
        .sendMessage(buildExternalInternalEventMessage(event))
        .then((response) => {
            const typed = response as
                | {
                      success?: unknown;
                      delivery?: {
                          subscriberCount?: unknown;
                          delivered?: unknown;
                          dropped?: unknown;
                      };
                  }
                | undefined;
            const delivery =
                typeof typed?.delivery?.subscriberCount === 'number' &&
                typeof typed.delivery.delivered === 'number' &&
                typeof typed.delivery.dropped === 'number'
                    ? {
                          listenerCount: typed.delivery.subscriberCount,
                          delivered: typed.delivery.delivered,
                          dropped: typed.delivery.dropped,
                      }
                    : null;
            markExternalConversationEventDispatched(
                ctx.externalEventDispatchState,
                event.conversation_id,
                event.attempt_id,
                event.content_hash,
                event.payload,
            );
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
            logger.debug('External event send failed', {
                conversationId: event.conversation_id,
                type: event.type,
                eventId: event.event_id,
                error,
            });
        });
};
