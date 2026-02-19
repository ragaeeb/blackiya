import type { appendToCaptureQueue, appendToLogQueue } from '@/entrypoints/interceptor/capture-queue';
import { safePathname } from '@/entrypoints/interceptor/discovery';
import { pruneTimestampCache } from '@/entrypoints/interceptor/state';
import type { LLMPlatform } from '@/platforms/types';
import { setBoundedMapValue } from '@/utils/bounded-collections';
import type {
    CaptureInterceptedMessage as CapturePayload,
    ConversationIdResolvedMessage,
    LogEntryMessage,
    ResponseFinishedMessage,
    ResponseLifecycleMessage,
    StreamDeltaMessage,
    StreamDumpFrameMessage,
} from '@/utils/protocol/messages';
import { stampToken } from '@/utils/protocol/session-token';

/** Mutable state shared between the emitter and the bootstrap message handlers. */
export type InterceptorEmitterState = {
    completionSignalCache: Map<string, number>;
    transientLogCache: Map<string, number>;
    capturePayloadCache: Map<string, number>;
    lifecycleSignalCache: Map<string, number>;
    conversationResolvedSignalCache: Map<string, number>;
    streamDumpFrameCountByAttempt: Map<string, number>;
    streamDumpLastTextByAttempt: Map<string, string>;
    /** Mutated by the emitter's internal cache-pruning sweep. */
    lastCachePruneAtMs: number;
    /** Written by the BLACKIYA_STREAM_DUMP_CONFIG message handler in bootstrap. */
    streamDumpEnabled: boolean;
};

export type InterceptorEmitterDeps = {
    state: InterceptorEmitterState;
    maxDedupeEntries: number;
    maxStreamDumpAttempts: number;
    cacheTtlMs: number;
    cachePruneIntervalMs: number;
    defaultPlatformName: string;
    resolveAttemptIdForConversation: (conversationId?: string, platformName?: string) => string;
    bindAttemptToConversation: (attemptId: string | null | undefined, conversationId: string | undefined) => void;
    isAttemptDisposed: (attemptId: string | undefined) => boolean;
    appendToLogQueue: typeof appendToLogQueue;
    appendToCaptureQueue: typeof appendToCaptureQueue;
};

export type InterceptorEmitter = ReturnType<typeof createInterceptorEmitter>;

export const createInterceptorEmitter = (deps: InterceptorEmitterDeps) => {
    const {
        state,
        maxDedupeEntries,
        maxStreamDumpAttempts,
        cacheTtlMs,
        cachePruneIntervalMs,
        defaultPlatformName,
        resolveAttemptIdForConversation,
        bindAttemptToConversation,
        isAttemptDisposed,
        appendToLogQueue,
        appendToCaptureQueue,
    } = deps;

    // ── Cache maintenance ────────────────────────────────────────────────────

    const maybePruneTimestampCaches = (nowMs = Date.now()) => {
        if (nowMs - state.lastCachePruneAtMs < cachePruneIntervalMs) {
            return;
        }
        state.lastCachePruneAtMs = nowMs;
        pruneTimestampCache(state.completionSignalCache, cacheTtlMs, nowMs);
        pruneTimestampCache(state.transientLogCache, cacheTtlMs, nowMs);
        pruneTimestampCache(state.capturePayloadCache, cacheTtlMs, nowMs);
        pruneTimestampCache(state.lifecycleSignalCache, cacheTtlMs, nowMs);
        pruneTimestampCache(state.conversationResolvedSignalCache, cacheTtlMs, nowMs);
    };

    // ── Logging ──────────────────────────────────────────────────────────────

    const log = (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => {
        const displayData = data ? ` ${JSON.stringify(data)}` : '';
        if (level === 'error') {
            console.error(message + displayData);
        } else if (level === 'warn') {
            console.warn(message + displayData);
        }
        const payload: LogEntryMessage = {
            type: 'LLM_LOG_ENTRY',
            payload: { level, message, data: data ? [data] : [], context: 'interceptor' },
        };
        const stamped = stampToken(payload);
        appendToLogQueue(stamped);
        window.postMessage(stamped, window.location.origin);
    };

    /** Returns true at most once per `intervalMs` for a given key. Side-effect: prunes stale cache entries. */
    const shouldLogTransient = (key: string, intervalMs = 2000) => {
        const now = Date.now();
        maybePruneTimestampCaches(now);
        const last = state.transientLogCache.get(key) ?? 0;
        if (now - last < intervalMs) {
            return false;
        }
        setBoundedMapValue(state.transientLogCache, key, now, maxDedupeEntries);
        return true;
    };

    // ── Deduplication guards ─────────────────────────────────────────────────

    const shouldEmitCapturedPayload = (adapterName: string, url: string, payload: string, intervalMs = 5000) => {
        const path = safePathname(url);
        const suffix = payload.length > 128 ? payload.slice(payload.length - 128) : payload;
        const key = `${adapterName}:${path}:${payload.length}:${suffix}`;
        const now = Date.now();
        maybePruneTimestampCaches(now);
        const last = state.capturePayloadCache.get(key) ?? 0;
        if (now - last < intervalMs) {
            return false;
        }
        setBoundedMapValue(state.capturePayloadCache, key, now, maxDedupeEntries);
        return true;
    };

    const shouldEmitLifecycleSignal = (phase: ResponseLifecycleMessage['phase'], conversationId?: string) => {
        const key = `${phase}:${conversationId ?? 'unknown'}`;
        const now = Date.now();
        maybePruneTimestampCaches(now);
        const last = state.lifecycleSignalCache.get(key) ?? 0;
        if (now - last < 300) {
            return false;
        }
        setBoundedMapValue(state.lifecycleSignalCache, key, now, maxDedupeEntries);
        return true;
    };

    // ── Signal emitters ──────────────────────────────────────────────────────

    const emitCapturePayload = (url: string, data: string, platform: string, attemptId?: string) => {
        if (isAttemptDisposed(attemptId)) {
            return;
        }
        const payload: CapturePayload = {
            type: 'LLM_CAPTURE_DATA_INTERCEPTED',
            url,
            data,
            platform,
            ...(attemptId ? { attemptId } : {}),
        };
        const stamped = stampToken(payload);
        appendToCaptureQueue(stamped);
        window.postMessage(stamped, window.location.origin);
    };

    const emitConversationIdResolved = (attemptId: string, conversationId: string, platformOverride?: string) => {
        const key = `${attemptId}:${conversationId}`;
        const now = Date.now();
        maybePruneTimestampCaches(now);
        if (now - (state.conversationResolvedSignalCache.get(key) ?? 0) < 1200) {
            return;
        }
        setBoundedMapValue(state.conversationResolvedSignalCache, key, now, maxDedupeEntries);
        bindAttemptToConversation(attemptId, conversationId);
        const payload: ConversationIdResolvedMessage = {
            type: 'BLACKIYA_CONVERSATION_ID_RESOLVED',
            platform: platformOverride ?? defaultPlatformName,
            attemptId,
            conversationId,
        };
        window.postMessage(stampToken(payload), window.location.origin);
    };

    const emitLifecycle = (
        attemptId: string,
        phase: ResponseLifecycleMessage['phase'],
        conversationId?: string,
        platformOverride?: string,
    ) => {
        if (!shouldEmitLifecycleSignal(phase, conversationId) || isAttemptDisposed(attemptId)) {
            return;
        }
        bindAttemptToConversation(attemptId, conversationId);
        const platform = platformOverride ?? defaultPlatformName;
        const payload: ResponseLifecycleMessage = {
            type: 'BLACKIYA_RESPONSE_LIFECYCLE',
            platform,
            attemptId,
            phase,
            conversationId,
        };
        window.postMessage(stampToken(payload), window.location.origin);
        log('info', 'lifecycle signal', { platform, phase, conversationId: conversationId ?? null });
    };

    const emitTitleResolved = (attemptId: string, conversationId: string, title: string, platformOverride?: string) => {
        if (isAttemptDisposed(attemptId)) {
            return;
        }
        const payload = {
            type: 'BLACKIYA_TITLE_RESOLVED' as const,
            platform: platformOverride ?? defaultPlatformName,
            attemptId,
            conversationId,
            title,
        };
        window.postMessage(stampToken(payload), window.location.origin);
        log('info', 'title resolved from stream', { conversationId, title });
    };

    const emitStreamDelta = (
        attemptId: string,
        conversationId: string | undefined,
        text: string,
        platformOverride?: string,
    ) => {
        const normalized = text.replace(/\r\n/g, '\n');
        const trimmed = normalized.trim();
        if (trimmed.length === 0 || /^v\d+$/i.test(trimmed) || isAttemptDisposed(attemptId)) {
            return;
        }
        bindAttemptToConversation(attemptId, conversationId);
        const payload: StreamDeltaMessage = {
            type: 'BLACKIYA_STREAM_DELTA',
            platform: platformOverride ?? defaultPlatformName,
            attemptId,
            conversationId,
            text: normalized,
        };
        window.postMessage(stampToken(payload), window.location.origin);
    };

    const emitStreamDumpFrame = (
        attemptId: string,
        conversationId: string | undefined,
        kind: StreamDumpFrameMessage['kind'],
        text: string,
        chunkBytes?: number,
        platformOverride?: string,
    ) => {
        if (!state.streamDumpEnabled || isAttemptDisposed(attemptId)) {
            return;
        }
        const normalized = text.replace(/\r\n/g, '\n');
        const trimmed = normalized.trim();
        if (trimmed.length === 0 || /^v\d+$/i.test(trimmed)) {
            return;
        }
        if (state.streamDumpLastTextByAttempt.get(attemptId) === normalized) {
            return;
        }
        setBoundedMapValue(state.streamDumpLastTextByAttempt, attemptId, normalized, maxStreamDumpAttempts);
        const frameIndex = (state.streamDumpFrameCountByAttempt.get(attemptId) ?? 0) + 1;
        setBoundedMapValue(state.streamDumpFrameCountByAttempt, attemptId, frameIndex, maxStreamDumpAttempts);
        const payload: StreamDumpFrameMessage = {
            type: 'BLACKIYA_STREAM_DUMP_FRAME',
            platform: platformOverride ?? defaultPlatformName,
            attemptId,
            conversationId,
            kind,
            text: normalized,
            frameIndex,
            timestampMs: Date.now(),
            ...(typeof chunkBytes === 'number' ? { chunkBytes } : {}),
        };
        window.postMessage(stampToken(payload), window.location.origin);
    };

    /** Wraps emitStreamDumpFrame with an API-response header and body preview. */
    const emitApiResponseDumpFrame = (
        adapterName: string,
        url: string,
        responseText: string,
        attemptId: string,
        conversationId?: string,
    ) => {
        if (!state.streamDumpEnabled) {
            return;
        }
        const path = safePathname(url);
        const header = `[${adapterName} API] ${path} (${responseText.length}b)`;
        const body =
            responseText.length > 8000
                ? `${responseText.slice(0, 8000)}\n...<truncated ${responseText.length - 8000}b>`
                : responseText;
        emitStreamDumpFrame(
            attemptId,
            conversationId,
            'snapshot',
            `${header}\n${body}`,
            responseText.length,
            adapterName,
        );
    };

    const emitResponseFinished = (adapter: LLMPlatform, url: string) => {
        const conversationId = adapter.extractConversationIdFromUrl?.(url) ?? undefined;
        const attemptId = resolveAttemptIdForConversation(conversationId, adapter.name);
        const dedupeKey = `${adapter.name}:${conversationId ?? safePathname(url)}`;
        const now = Date.now();
        maybePruneTimestampCaches(now);
        if (now - (state.completionSignalCache.get(dedupeKey) ?? 0) < 1500) {
            return;
        }
        setBoundedMapValue(state.completionSignalCache, dedupeKey, now, maxDedupeEntries);
        const payload: ResponseFinishedMessage = {
            type: 'BLACKIYA_RESPONSE_FINISHED',
            platform: adapter.name,
            attemptId,
            conversationId,
        };
        window.postMessage(stampToken(payload), window.location.origin);
        log('info', 'response finished hint', {
            platform: adapter.name,
            conversationId: conversationId ?? null,
            path: safePathname(url),
        });
    };

    /** Builds the callback bundle passed into all platform stream monitors. */
    const createStreamMonitorEmitter = () => ({
        conversationIdResolved: emitConversationIdResolved,
        lifecycle: emitLifecycle,
        streamDelta: emitStreamDelta,
        streamDump: emitStreamDumpFrame,
        titleResolved: emitTitleResolved,
        isAttemptDisposed,
        shouldLogTransient,
        log,
    });

    return {
        log,
        shouldLogTransient,
        shouldEmitCapturedPayload,
        shouldEmitLifecycleSignal,
        emitCapturePayload,
        emitConversationIdResolved,
        emitLifecycle,
        emitTitleResolved,
        emitStreamDelta,
        emitStreamDumpFrame,
        emitApiResponseDumpFrame,
        emitResponseFinished,
        createStreamMonitorEmitter,
    };
};
