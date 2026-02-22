/**
 * Wire message handlers for the runner.
 *
 * Processes cross-world postMessage events (lifecycle, response-finished,
 * stream-delta, title-resolved, conversation-id-resolved, attempt-disposed,
 * and stream-dump-frame).
 */

import type { LLMPlatform } from '@/platforms/types';
import { setBoundedMapValue } from '@/utils/bounded-collections';
import type { StreamDumpFrameInput } from '@/utils/diagnostics-stream-dump';
import { logger } from '@/utils/logger';
import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import type {
    AttemptDisposedMessage,
    ConversationIdResolvedMessage,
    ResponseFinishedMessage,
    ResponseLifecycleMessage,
    StreamDeltaMessage,
    StreamDumpFrameMessage,
    TitleResolvedMessage,
} from '@/utils/protocol/messages';
import { type RunnerStreamPreviewState, removePendingRunnerStreamPreview } from '@/utils/runner/stream-preview';
import { resolveConversationTitleByPrecedence } from '@/utils/title-resolver';
import type { ConversationData } from '@/utils/types';

type LifecycleUiState = 'idle' | 'prompt-sent' | 'streaming' | 'completed';

export type WireMessageHandlerDeps = {
    getAdapter: () => LLMPlatform | null;
    getCurrentConversationId: () => string | null;
    getActiveAttemptId: () => string | null;

    resolveAliasedAttemptId: (attemptId: string) => string;
    isStaleAttemptMessage: (
        attemptId: string,
        conversationId: string | undefined,
        signalType: 'lifecycle' | 'finished' | 'delta' | 'conversation-resolved',
    ) => boolean;
    forwardAttemptAlias: (from: string, to: string, reason: 'superseded' | 'rebound') => void;

    setActiveAttempt: (attemptId: string | null) => void;
    setCurrentConversation: (conversationId: string | null) => void;
    bindAttempt: (conversationId: string | undefined, attemptId: string) => void;

    getLifecycleState: () => LifecycleUiState;
    setLifecycleState: (state: LifecycleUiState, conversationId?: string) => void;
    setLifecycleAttemptId: (id: string) => void;
    setLifecycleConversationId: (id: string) => void;
    isPlatformGenerating: () => boolean;

    streamResolvedTitles: Map<string, string>;
    maxStreamResolvedTitles: number;
    getConversation: (cid: string) => ConversationData | undefined;

    cachePendingLifecycleSignal: (
        attemptId: string,
        phase: ResponseLifecycleMessage['phase'],
        platform: string,
    ) => void;
    ingestSfeLifecycleFromWirePhase: (
        phase: ResponseLifecycleMessage['phase'],
        attemptId: string,
        conversationId?: string | null,
    ) => void;
    applyLifecyclePhaseForConversation: (
        phase: ResponseLifecycleMessage['phase'],
        platform: string,
        attemptId: string,
        conversationId: string,
        source: 'direct' | 'replayed',
    ) => void;

    handleResponseFinished: (source: 'network' | 'dom', hintedConversationId?: string) => void;

    appendPendingStreamProbeText: (attemptId: string, text: string) => void;
    appendLiveStreamProbeText: (conversationId: string, text: string) => void;

    isStreamDumpEnabled: () => boolean;
    saveStreamDumpFrame: (frame: StreamDumpFrameInput) => void;

    pendingLifecycleByAttempt: Map<
        string,
        { phase: ResponseLifecycleMessage['phase']; platform: string; receivedAtMs: number }
    >;
    sfeUpdateConversationId: (attemptId: string, conversationId: string) => void;
    refreshButtonState: (conversationId?: string) => void;

    cancelStreamDoneProbe: (attemptId: string, reason: 'superseded' | 'disposed') => void;
    clearCanonicalStabilizationRetry: (attemptId: string) => void;
    sfeDispose: (attemptId: string) => void;
    streamPreviewState: RunnerStreamPreviewState;
    attemptByConversation: Map<string, string>;
    shouldRemoveDisposedAttemptBinding: (mapped: string, disposed: string, resolve: (id: string) => string) => boolean;
};

export const handleTitleResolvedMessage = (message: unknown, deps: WireMessageHandlerDeps): boolean => {
    const typed = message as TitleResolvedMessage | undefined;
    if (
        typed?.type !== MESSAGE_TYPES.TITLE_RESOLVED ||
        typeof typed.conversationId !== 'string' ||
        typeof typed.title !== 'string'
    ) {
        return false;
    }
    const title = typed.title.trim();
    if (title.length === 0) {
        return true;
    }
    const platformDefaultTitles = deps.getAdapter()?.defaultTitles;
    const streamDecision = resolveConversationTitleByPrecedence({
        streamTitle: title,
        cachedTitle: deps.streamResolvedTitles.get(typed.conversationId) ?? null,
        fallbackTitle: title,
        platformDefaultTitles,
    });
    setBoundedMapValue(
        deps.streamResolvedTitles,
        typed.conversationId,
        streamDecision.title,
        deps.maxStreamResolvedTitles,
    );
    const cached = deps.getConversation(typed.conversationId);
    if (cached) {
        const cacheDecision = resolveConversationTitleByPrecedence({
            streamTitle: title,
            cachedTitle: cached.title ?? null,
            fallbackTitle: cached.title ?? 'Conversation',
            platformDefaultTitles,
        });
        cached.title = cacheDecision.title;
    }
    logger.info('Title resolved from stream', {
        conversationId: typed.conversationId,
        title,
        resolvedTitle: streamDecision.title,
        source: streamDecision.source,
    });
    return true;
};

export const handleResponseFinishedMessage = (message: unknown, deps: WireMessageHandlerDeps): boolean => {
    const typed = message as ResponseFinishedMessage | undefined;
    if (typed?.type !== MESSAGE_TYPES.RESPONSE_FINISHED || typeof typed.attemptId !== 'string') {
        return false;
    }
    const hintedConversationId = typeof typed.conversationId === 'string' ? typed.conversationId : undefined;
    const adapter = deps.getAdapter();
    const resolvedConversationId =
        hintedConversationId ??
        (adapter ? adapter.extractConversationId(window.location.href) : null) ??
        deps.getCurrentConversationId();
    if (!resolvedConversationId) {
        logger.info('RESPONSE_FINISHED ignored: missing conversation context', {
            attemptId: typed.attemptId,
            platform: typed.platform,
        });
        return true;
    }
    const attemptId = deps.resolveAliasedAttemptId(typed.attemptId);
    if (deps.isStaleAttemptMessage(attemptId, resolvedConversationId, 'finished')) {
        return true;
    }
    deps.setActiveAttempt(attemptId);
    deps.bindAttempt(resolvedConversationId, attemptId);
    const lifecycleState = deps.getLifecycleState();
    if (lifecycleState === 'prompt-sent' || lifecycleState === 'streaming') {
        const shouldReject = adapter?.name === 'ChatGPT' && deps.isPlatformGenerating();
        if (shouldReject) {
            logger.info('RESPONSE_FINISHED rejected: platform still generating', {
                conversationId: resolvedConversationId,
                attemptId,
                lifecycleState,
            });
            return true;
        }
        logger.info('RESPONSE_FINISHED promoted lifecycle to completed', {
            conversationId: resolvedConversationId,
            attemptId,
            previousLifecycle: lifecycleState,
        });
        deps.setLifecycleAttemptId(attemptId);
        deps.setLifecycleConversationId(resolvedConversationId);
        deps.setLifecycleState('completed', resolvedConversationId);
    }
    deps.handleResponseFinished('network', resolvedConversationId);
    return true;
};

export const handleLifecycleMessage = (message: unknown, deps: WireMessageHandlerDeps): boolean => {
    const typed = message as ResponseLifecycleMessage | undefined;
    if (typed?.type !== MESSAGE_TYPES.RESPONSE_LIFECYCLE || typeof typed.attemptId !== 'string') {
        return false;
    }
    const phase = typed.phase;
    if (phase !== 'prompt-sent' && phase !== 'streaming' && phase !== 'completed' && phase !== 'terminated') {
        return false;
    }
    const attemptId = deps.resolveAliasedAttemptId(typed.attemptId);
    const conversationId = typeof typed.conversationId === 'string' ? typed.conversationId : undefined;

    if (!conversationId) {
        deps.cachePendingLifecycleSignal(attemptId, phase, typed.platform);
        deps.ingestSfeLifecycleFromWirePhase(phase, attemptId, null);
        logger.info('Lifecycle pending conversation resolution', {
            phase,
            platform: typed.platform,
            attemptId: typed.attemptId,
        });
        if (phase === 'prompt-sent' || phase === 'streaming') {
            deps.setLifecycleAttemptId(attemptId);
            deps.setLifecycleState(phase);
        }
        return true;
    }

    if (phase === 'prompt-sent') {
        deps.bindAttempt(conversationId, attemptId);
    }
    if (deps.isStaleAttemptMessage(attemptId, conversationId, 'lifecycle')) {
        return true;
    }
    deps.setCurrentConversation(conversationId);
    deps.bindAttempt(conversationId, attemptId);
    deps.setActiveAttempt(attemptId);
    deps.applyLifecyclePhaseForConversation(phase, typed.platform, attemptId, conversationId, 'direct');
    return true;
};

export const handleStreamDeltaMessage = (message: unknown, deps: WireMessageHandlerDeps): boolean => {
    const typed = message as StreamDeltaMessage | undefined;
    if (typed?.type !== MESSAGE_TYPES.STREAM_DELTA || typeof typed.attemptId !== 'string') {
        return false;
    }
    if (typeof typed.text !== 'string' || typed.text.length === 0) {
        return false;
    }
    const conversationId =
        typeof typed.conversationId === 'string' && typed.conversationId.length > 0
            ? typed.conversationId
            : deps.getCurrentConversationId();
    const attemptId = deps.resolveAliasedAttemptId(typed.attemptId);
    if (deps.isStaleAttemptMessage(attemptId, conversationId ?? undefined, 'delta')) {
        return true;
    }
    deps.setActiveAttempt(attemptId);
    if (!conversationId) {
        const lifecycleState = deps.getLifecycleState();
        if (lifecycleState !== 'completed' && lifecycleState !== 'streaming') {
            deps.setLifecycleAttemptId(attemptId);
            deps.setLifecycleState('streaming');
        }
        deps.appendPendingStreamProbeText(attemptId, typed.text);
        return true;
    }
    deps.bindAttempt(conversationId, attemptId);
    deps.appendLiveStreamProbeText(conversationId, typed.text);
    return true;
};

export const handleStreamDumpFrameMessage = (message: unknown, deps: WireMessageHandlerDeps): boolean => {
    const typed = message as StreamDumpFrameMessage | undefined;
    if (typed?.type !== MESSAGE_TYPES.STREAM_DUMP_FRAME) {
        return false;
    }
    if (
        typeof typed.attemptId !== 'string' ||
        typeof typed.platform !== 'string' ||
        typeof typed.text !== 'string' ||
        typeof typed.kind !== 'string'
    ) {
        return true;
    }
    if (!deps.isStreamDumpEnabled() || deps.isStaleAttemptMessage(typed.attemptId, typed.conversationId, 'delta')) {
        return true;
    }
    deps.saveStreamDumpFrame({
        platform: typed.platform,
        attemptId: typed.attemptId,
        conversationId: typed.conversationId,
        kind: typed.kind,
        text: typed.text,
        chunkBytes: typed.chunkBytes,
        frameIndex: typed.frameIndex,
        timestampMs: typed.timestampMs,
    });
    return true;
};

export const handleConversationIdResolvedMessage = (message: unknown, deps: WireMessageHandlerDeps): boolean => {
    const typed = message as ConversationIdResolvedMessage | undefined;
    if (typed?.type !== MESSAGE_TYPES.CONVERSATION_ID_RESOLVED) {
        return false;
    }
    if (typeof typed.attemptId !== 'string' || typeof typed.conversationId !== 'string') {
        return false;
    }
    const canonicalAttemptId = deps.resolveAliasedAttemptId(typed.attemptId);
    if (canonicalAttemptId !== typed.attemptId) {
        deps.forwardAttemptAlias(typed.attemptId, canonicalAttemptId, 'rebound');
    }
    if (deps.isStaleAttemptMessage(canonicalAttemptId, typed.conversationId, 'conversation-resolved')) {
        return true;
    }
    deps.setActiveAttempt(canonicalAttemptId);
    deps.setCurrentConversation(typed.conversationId);
    deps.bindAttempt(typed.conversationId, canonicalAttemptId);
    deps.sfeUpdateConversationId(canonicalAttemptId, typed.conversationId);
    const pending = deps.pendingLifecycleByAttempt.get(canonicalAttemptId);
    if (pending) {
        deps.pendingLifecycleByAttempt.delete(canonicalAttemptId);
        deps.applyLifecyclePhaseForConversation(
            pending.phase,
            pending.platform,
            canonicalAttemptId,
            typed.conversationId,
            'replayed',
        );
    }
    deps.refreshButtonState(typed.conversationId);
    return true;
};

export const handleAttemptDisposedMessage = (message: unknown, deps: WireMessageHandlerDeps): boolean => {
    const typed = message as AttemptDisposedMessage | undefined;
    if (typed?.type !== MESSAGE_TYPES.ATTEMPT_DISPOSED || typeof typed.attemptId !== 'string') {
        return false;
    }
    const canonicalDisposedId = deps.resolveAliasedAttemptId(typed.attemptId);
    deps.cancelStreamDoneProbe(canonicalDisposedId, typed.reason === 'superseded' ? 'superseded' : 'disposed');
    deps.clearCanonicalStabilizationRetry(canonicalDisposedId);
    deps.sfeDispose(canonicalDisposedId);
    deps.pendingLifecycleByAttempt.delete(canonicalDisposedId);
    removePendingRunnerStreamPreview(deps.streamPreviewState, canonicalDisposedId);
    for (const [conversationId, mappedAttemptId] of deps.attemptByConversation.entries()) {
        if (
            deps.shouldRemoveDisposedAttemptBinding(mappedAttemptId, canonicalDisposedId, deps.resolveAliasedAttemptId)
        ) {
            deps.attemptByConversation.delete(conversationId);
        }
    }
    if (
        deps.getActiveAttemptId() &&
        deps.shouldRemoveDisposedAttemptBinding(
            deps.getActiveAttemptId()!,
            canonicalDisposedId,
            deps.resolveAliasedAttemptId,
        )
    ) {
        deps.setActiveAttempt(null);
    }
    return true;
};
