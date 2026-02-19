import { createInterceptorAttemptRegistry } from '@/entrypoints/interceptor/attempt-registry';
import {
    extractConversationIdFromAnyUrl,
    extractLatestAssistantText,
    getApiUrlCandidates,
    isCapturedConversationReady,
    isFetchReady,
    parseConversationData,
    resolveLifecycleConversationId,
    resolveParsedConversationId,
    resolveRequestConversationId,
} from '@/entrypoints/interceptor/conversation-utils';
import {
    detectPlatformFromHostname,
    isDiscoveryDiagnosticsEnabled,
    safePathname,
} from '@/entrypoints/interceptor/discovery';
import { createFetchInterceptorContext, type FetchInterceptorContext } from '@/entrypoints/interceptor/fetch-pipeline';
import { createFetchInterceptor } from '@/entrypoints/interceptor/fetch-wrapper';
import { getPageConversationSnapshot } from '@/entrypoints/interceptor/page-snapshot';
import { ProactiveFetcher } from '@/entrypoints/interceptor/proactive-fetcher';
import { shouldEmitXhrRequestLifecycle } from '@/entrypoints/interceptor/signal-emitter';
import { createWindowJsonRequester } from '@/entrypoints/interceptor/snapshot-bridge';
import { cleanupDisposedAttemptState, pruneTimestampCache } from '@/entrypoints/interceptor/state';
import { monitorChatGptSseLifecycle } from '@/entrypoints/interceptor/stream-monitors/chatgpt-sse-lifecycle';
import {
    monitorGeminiResponseStream,
    wireGeminiXhrProgressMonitor,
} from '@/entrypoints/interceptor/stream-monitors/gemini-lifecycle';
import {
    monitorGrokResponseStream,
    wireGrokXhrProgressMonitor,
} from '@/entrypoints/interceptor/stream-monitors/grok-lifecycle';
import type { StreamMonitorEmitter } from '@/entrypoints/interceptor/stream-monitors/stream-emitter';
import { buildXhrLifecycleContext, type XhrLifecycleContext } from '@/entrypoints/interceptor/xhr-pipeline';
import { notifyXhrOpen } from '@/entrypoints/interceptor/xhr-wrapper';
import { chatGPTAdapter } from '@/platforms/chatgpt';
import { SUPPORTED_PLATFORM_URLS } from '@/platforms/constants';
import { getPlatformAdapterByApiUrl, getPlatformAdapterByCompletionUrl } from '@/platforms/factory';
import type { LLMPlatform } from '@/platforms/types';
import { setBoundedMapValue } from '@/utils/bounded-collections';
import { shouldEmitGeminiCompletion, shouldEmitGeminiLifecycle } from '@/utils/gemini-request-classifier';
import {
    isGrokStreamingEndpoint,
    shouldEmitGrokCompletion,
    shouldEmitGrokLifecycle,
} from '@/utils/grok-request-classifier';
import {
    extractForwardableHeadersFromFetchArgs,
    type HeaderRecord,
    mergeHeaderRecords,
    toForwardableHeaderRecord,
} from '@/utils/proactive-fetch-headers';
import type {
    AttemptDisposedMessage,
    CaptureInterceptedMessage as CapturePayload,
    ConversationIdResolvedMessage,
    LogEntryMessage as InterceptorLogPayload,
    ResponseFinishedMessage as ResponseFinishedSignal,
    ResponseLifecycleMessage as ResponseLifecycleSignal,
    StreamDeltaMessage as ResponseStreamDeltaSignal,
    SessionInitMessage,
    StreamDumpConfigMessage,
    StreamDumpFrameMessage,
} from '@/utils/protocol/messages';
import {
    getSessionToken,
    resolveTokenValidationFailureReason,
    setSessionToken,
    stampToken,
} from '@/utils/protocol/session-token';
import type { ConversationData } from '@/utils/types';

export {
    shouldEmitXhrRequestLifecycle,
    tryEmitGeminiXhrLoadendCompletion,
    tryMarkGeminiXhrLoadendCompleted,
} from '@/entrypoints/interceptor/signal-emitter';
export { cleanupDisposedAttemptState, pruneTimestampCache } from '@/entrypoints/interceptor/state';

interface PageSnapshotRequest {
    type: 'BLACKIYA_PAGE_SNAPSHOT_REQUEST';
    requestId: string;
    conversationId: string;
    __blackiyaToken?: string;
}

interface PageSnapshotResponse {
    type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE';
    requestId: string;
    success: boolean;
    data?: unknown;
    error?: string;
    __blackiyaToken?: string;
}

const completionSignalCache = new Map<string, number>();
const transientLogCache = new Map<string, number>();
const capturePayloadCache = new Map<string, number>();
const lifecycleSignalCache = new Map<string, number>();
const attemptByConversationId = new Map<string, string>();
const conversationResolvedSignalCache = new Map<string, number>();
const disposedAttemptIds = new Set<string>();
const streamDumpFrameCountByAttempt = new Map<string, number>();
const streamDumpLastTextByAttempt = new Map<string, string>();
const latestAttemptIdByPlatform = new Map<string, string>();

const MAX_INTERCEPTOR_DEDUPE_CACHE_ENTRIES = 300;
const MAX_INTERCEPTOR_ATTEMPT_BINDINGS = 400;
const MAX_INTERCEPTOR_STREAM_DUMP_ATTEMPTS = 250;
const BLACKIYA_GET_JSON_REQUEST = 'BLACKIYA_GET_JSON_REQUEST';
const BLACKIYA_GET_JSON_RESPONSE = 'BLACKIYA_GET_JSON_RESPONSE';
const JSON_FORMAT_ORIGINAL = 'original';
const JSON_FORMAT_COMMON = 'common';
const INTERCEPTOR_CACHE_ENTRY_TTL_MS = 60_000;
const INTERCEPTOR_CACHE_PRUNE_INTERVAL_MS = 15_000;
const INTERCEPTOR_RUNTIME_TAG = 'v2.1.1-grok-stream';

let lastCachePruneAtMs = 0;
let streamDumpEnabled = false;

const attemptRegistry = createInterceptorAttemptRegistry({
    state: { attemptByConversationId, latestAttemptIdByPlatform, disposedAttemptIds },
    maxAttemptBindings: MAX_INTERCEPTOR_ATTEMPT_BINDINGS,
    defaultPlatformName: chatGPTAdapter.name,
});
const { bindAttemptToConversation, resolveAttemptIdForConversation, peekAttemptIdForConversation, isAttemptDisposed } =
    attemptRegistry;

// ---------------------------------------------------------------------------
// Cache pruning
// ---------------------------------------------------------------------------

const maybePruneTimestampCaches = (nowMs = Date.now()): void => {
    if (nowMs - lastCachePruneAtMs < INTERCEPTOR_CACHE_PRUNE_INTERVAL_MS) {
        return;
    }
    lastCachePruneAtMs = nowMs;
    pruneTimestampCache(completionSignalCache, INTERCEPTOR_CACHE_ENTRY_TTL_MS, nowMs);
    pruneTimestampCache(transientLogCache, INTERCEPTOR_CACHE_ENTRY_TTL_MS, nowMs);
    pruneTimestampCache(capturePayloadCache, INTERCEPTOR_CACHE_ENTRY_TTL_MS, nowMs);
    pruneTimestampCache(lifecycleSignalCache, INTERCEPTOR_CACHE_ENTRY_TTL_MS, nowMs);
    pruneTimestampCache(conversationResolvedSignalCache, INTERCEPTOR_CACHE_ENTRY_TTL_MS, nowMs);
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const log = (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => {
    const displayData = data ? ` ${JSON.stringify(data)}` : '';
    if (level === 'error') {
        console.error(message + displayData);
    } else if (level === 'warn') {
        console.warn(message + displayData);
    }

    const payload: InterceptorLogPayload = {
        type: 'LLM_LOG_ENTRY',
        payload: { level, message, data: data ? [data] : [], context: 'interceptor' },
    };
    const stamped = stampToken(payload);
    queueLogMessage(stamped);
    window.postMessage(stamped, window.location.origin);
};

const shouldLogTransient = (key: string, intervalMs = 2000): boolean => {
    const now = Date.now();
    maybePruneTimestampCaches(now);
    const last = transientLogCache.get(key) ?? 0;
    if (now - last < intervalMs) {
        return false;
    }
    setBoundedMapValue(transientLogCache, key, now, MAX_INTERCEPTOR_DEDUPE_CACHE_ENTRIES);
    return true;
};

// ---------------------------------------------------------------------------
// Capture queue
// ---------------------------------------------------------------------------

const queueLogMessage = (payload: InterceptorLogPayload & { __blackiyaToken: string }) => {
    const queue = ((window as any).__BLACKIYA_LOG_QUEUE__ as (typeof payload)[] | undefined) ?? [];
    queue.push(payload);
    if (queue.length > 100) {
        queue.splice(0, queue.length - 100);
    }
    (window as any).__BLACKIYA_LOG_QUEUE__ = queue;
};

const cacheRawCapture = (payload: CapturePayload): void => {
    const history = ((window as any).__BLACKIYA_RAW_CAPTURE_HISTORY__ as CapturePayload[] | undefined) ?? [];
    history.push(payload);
    if (history.length > 30) {
        history.splice(0, history.length - 30);
    }
    (window as any).__BLACKIYA_RAW_CAPTURE_HISTORY__ = history;
};

const getRawCaptureHistory = (): CapturePayload[] => {
    const history = (window as any).__BLACKIYA_RAW_CAPTURE_HISTORY__;
    return Array.isArray(history) ? (history as CapturePayload[]) : [];
};

const queueInterceptedMessage = (payload: CapturePayload & { __blackiyaToken: string }) => {
    const queue = ((window as any).__BLACKIYA_CAPTURE_QUEUE__ as (typeof payload)[] | undefined) ?? [];
    queue.push(payload);
    if (queue.length > 50) {
        queue.splice(0, queue.length - 50);
    }
    (window as any).__BLACKIYA_CAPTURE_QUEUE__ = queue;
    cacheRawCapture(payload);
};

// ---------------------------------------------------------------------------
// Signal emission
// ---------------------------------------------------------------------------

const shouldEmitCapturedPayload = (adapterName: string, url: string, payload: string, intervalMs = 5000): boolean => {
    const path = safePathname(url);
    const suffix = payload.length > 128 ? payload.slice(payload.length - 128) : payload;
    const key = `${adapterName}:${path}:${payload.length}:${suffix}`;
    const now = Date.now();
    maybePruneTimestampCaches(now);
    const last = capturePayloadCache.get(key) ?? 0;
    if (now - last < intervalMs) {
        return false;
    }
    setBoundedMapValue(capturePayloadCache, key, now, MAX_INTERCEPTOR_DEDUPE_CACHE_ENTRIES);
    return true;
};

const emitCapturePayload = (url: string, data: string, platform: string, attemptId?: string): void => {
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
    queueInterceptedMessage(stamped);
    window.postMessage(stamped, window.location.origin);
};

const emitConversationIdResolvedSignal = (
    attemptId: string,
    conversationId: string,
    platformOverride?: string,
): void => {
    const key = `${attemptId}:${conversationId}`;
    const now = Date.now();
    maybePruneTimestampCaches(now);
    if (now - (conversationResolvedSignalCache.get(key) ?? 0) < 1200) {
        return;
    }
    setBoundedMapValue(conversationResolvedSignalCache, key, now, MAX_INTERCEPTOR_DEDUPE_CACHE_ENTRIES);
    bindAttemptToConversation(attemptId, conversationId);

    const payload: ConversationIdResolvedMessage = {
        type: 'BLACKIYA_CONVERSATION_ID_RESOLVED',
        platform: platformOverride ?? chatGPTAdapter.name,
        attemptId,
        conversationId,
    };
    window.postMessage(stampToken(payload), window.location.origin);
};

const shouldEmitLifecycleSignal = (phase: ResponseLifecycleSignal['phase'], conversationId?: string): boolean => {
    const key = `${phase}:${conversationId ?? 'unknown'}`;
    const now = Date.now();
    maybePruneTimestampCaches(now);
    const last = lifecycleSignalCache.get(key) ?? 0;
    if (now - last < 300) {
        return false;
    }
    setBoundedMapValue(lifecycleSignalCache, key, now, MAX_INTERCEPTOR_DEDUPE_CACHE_ENTRIES);
    return true;
};

const emitLifecycleSignal = (
    attemptId: string,
    phase: ResponseLifecycleSignal['phase'],
    conversationId?: string,
    platformOverride?: string,
): void => {
    if (!shouldEmitLifecycleSignal(phase, conversationId) || isAttemptDisposed(attemptId)) {
        return;
    }
    bindAttemptToConversation(attemptId, conversationId);

    const platform = platformOverride ?? chatGPTAdapter.name;
    const payload: ResponseLifecycleSignal = {
        type: 'BLACKIYA_RESPONSE_LIFECYCLE',
        platform,
        attemptId,
        phase,
        conversationId,
    };
    window.postMessage(stampToken(payload), window.location.origin);
    log('info', 'lifecycle signal', { platform, phase, conversationId: conversationId ?? null });
};

const emitTitleResolvedSignal = (
    attemptId: string,
    conversationId: string,
    title: string,
    platformOverride?: string,
): void => {
    if (isAttemptDisposed(attemptId)) {
        return;
    }
    const payload = {
        type: 'BLACKIYA_TITLE_RESOLVED' as const,
        platform: platformOverride ?? chatGPTAdapter.name,
        attemptId,
        conversationId,
        title,
    };
    window.postMessage(stampToken(payload), window.location.origin);
    log('info', 'title resolved from stream', { conversationId, title });
};

const emitStreamDeltaSignal = (
    attemptId: string,
    conversationId: string | undefined,
    text: string,
    platformOverride?: string,
): void => {
    const normalized = text.replace(/\r\n/g, '\n');
    const trimmed = normalized.trim();
    if (trimmed.length === 0 || /^v\d+$/i.test(trimmed) || isAttemptDisposed(attemptId)) {
        return;
    }
    bindAttemptToConversation(attemptId, conversationId);
    const payload: ResponseStreamDeltaSignal = {
        type: 'BLACKIYA_STREAM_DELTA',
        platform: platformOverride ?? chatGPTAdapter.name,
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
): void => {
    if (!streamDumpEnabled || isAttemptDisposed(attemptId)) {
        return;
    }
    const normalized = text.replace(/\r\n/g, '\n');
    const trimmed = normalized.trim();
    if (trimmed.length === 0 || /^v\d+$/i.test(trimmed)) {
        return;
    }

    const lastText = streamDumpLastTextByAttempt.get(attemptId);
    if (lastText === normalized) {
        return;
    }
    setBoundedMapValue(streamDumpLastTextByAttempt, attemptId, normalized, MAX_INTERCEPTOR_STREAM_DUMP_ATTEMPTS);

    const frameIndex = (streamDumpFrameCountByAttempt.get(attemptId) ?? 0) + 1;
    setBoundedMapValue(streamDumpFrameCountByAttempt, attemptId, frameIndex, MAX_INTERCEPTOR_STREAM_DUMP_ATTEMPTS);

    const payload: StreamDumpFrameMessage = {
        type: 'BLACKIYA_STREAM_DUMP_FRAME',
        platform: platformOverride ?? chatGPTAdapter.name,
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

const emitApiResponseDumpFrame = (
    adapterName: string,
    url: string,
    responseText: string,
    attemptId: string,
    conversationId?: string,
): void => {
    if (!streamDumpEnabled) {
        return;
    }
    const path = safePathname(url);
    const header = `[${adapterName} API] ${path} (${responseText.length}b)`;
    const body =
        responseText.length > 8000
            ? `${responseText.slice(0, 8000)}\n...<truncated ${responseText.length - 8000}b>`
            : responseText;
    emitStreamDumpFrame(attemptId, conversationId, 'snapshot', `${header}\n${body}`, responseText.length, adapterName);
};

const emitResponseFinishedSignal = (adapter: LLMPlatform, url: string): void => {
    const conversationId = adapter.extractConversationIdFromUrl?.(url) ?? undefined;
    const attemptId = resolveAttemptIdForConversation(conversationId, adapter.name);
    const dedupeKey = `${adapter.name}:${conversationId ?? safePathname(url)}`;
    const now = Date.now();
    maybePruneTimestampCaches(now);
    if (now - (completionSignalCache.get(dedupeKey) ?? 0) < 1500) {
        return;
    }
    setBoundedMapValue(completionSignalCache, dedupeKey, now, MAX_INTERCEPTOR_DEDUPE_CACHE_ENTRIES);

    const payload: ResponseFinishedSignal = {
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

// ---------------------------------------------------------------------------
// StreamMonitorEmitter factory — closes over module-level state/functions
// ---------------------------------------------------------------------------

/** Creates the signal-emitter bundle used by all platform stream monitors. */
const createStreamMonitorEmitter = (): StreamMonitorEmitter => ({
    conversationIdResolved: emitConversationIdResolvedSignal,
    lifecycle: emitLifecycleSignal,
    streamDelta: emitStreamDeltaSignal,
    streamDump: emitStreamDumpFrame,
    titleResolved: emitTitleResolvedSignal,
    isAttemptDisposed,
    shouldLogTransient,
    log,
});

// ---------------------------------------------------------------------------
// Completion-signal suppression helpers
// ---------------------------------------------------------------------------

const isGeminiTitlesEndpoint = (url: string): boolean =>
    /\/_\/BardChatUi\/data\/batchexecute/i.test(url) && /[?&]rpcids=MaZiqc(?:&|$)/i.test(url);

const shouldEmitCompletionSignalForUrl = (adapter: LLMPlatform, url: string): boolean => {
    if (adapter.name === 'Gemini') {
        return !isGeminiTitlesEndpoint(url) && shouldEmitGeminiCompletion(url);
    }
    if (adapter.name === 'Grok') {
        return shouldEmitGrokCompletion(url);
    }
    return true;
};

const shouldSuppressCompletionSignal = (adapter: LLMPlatform, url: string): boolean =>
    !shouldEmitCompletionSignalForUrl(adapter, url);

const shouldEmitCompletionSignalForParsedData = (
    adapter: LLMPlatform,
    url: string,
    parsed: ConversationData | null,
): boolean => {
    if (!shouldEmitCompletionSignalForUrl(adapter, url)) {
        return false;
    }
    if (adapter.name === 'Grok') {
        return isCapturedConversationReady(adapter, parsed);
    }
    return true;
};

const shouldEmitNonChatLifecycleForRequest = (adapter: LLMPlatform, url: string): boolean => {
    if (adapter.name === 'Gemini') {
        const allowed = shouldEmitGeminiLifecycle(url);
        if (!allowed && shouldLogTransient(`gemini:lifecycle-suppressed:${safePathname(url)}`, 8000)) {
            log('info', 'Gemini lifecycle suppressed for non-generation endpoint', { path: safePathname(url) });
        }
        return allowed;
    }
    if (adapter.name === 'Grok') {
        const allowed = shouldEmitGrokLifecycle(url);
        if (!allowed && shouldLogTransient(`grok:lifecycle-suppressed:${safePathname(url)}`, 8000)) {
            log('info', 'Grok lifecycle suppressed for non-generation endpoint', { path: safePathname(url) });
        }
        return allowed;
    }
    return true;
};

// ---------------------------------------------------------------------------
// Non-ChatGPT stream snapshot helper
// ---------------------------------------------------------------------------

const emitNonChatGptStreamSnapshot = (
    adapter: LLMPlatform,
    attemptId: string,
    conversationId: string | undefined,
    parsed: ConversationData | null,
): void => {
    if (!parsed || adapter.name === 'ChatGPT') {
        return;
    }
    const text = extractLatestAssistantText(parsed);
    if (!text) {
        return;
    }
    emitStreamDeltaSignal(attemptId, conversationId, text, adapter.name);
    emitStreamDumpFrame(attemptId, conversationId, 'snapshot', text, text.length, adapter.name);
};

// ---------------------------------------------------------------------------
// Discovery logging helpers
// ---------------------------------------------------------------------------

const isDiscoveryModeHost = (hostname: string): boolean =>
    hostname.includes('gemini.google.com') || hostname.includes('x.com') || hostname.includes('grok.com');

const isStaticAssetPath = (path: string): boolean =>
    !!path.match(/\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico)$/i);

const emitDiscoveryDumpFrame = (label: string, path: string, text: string): void => {
    if (!streamDumpEnabled || text.length <= 1000) {
        return;
    }
    const platform = detectPlatformFromHostname();
    const attemptId = `discovery:${platform.toLowerCase()}:${Date.now()}`;
    const preview = text.length > 8000 ? text.slice(0, 8000) : text;
    emitStreamDumpFrame(
        attemptId,
        undefined,
        'snapshot',
        `[${platform} ${label}] ${path} (${text.length}b)\n${preview}`,
        text.length,
        platform,
    );
};

const logConversationSkip = (channel: 'API' | 'XHR', url: string): void => {
    const path = safePathname(url);
    if (shouldLogTransient(`${channel}:skip:${path}`, 2500)) {
        log('info', `${channel} skip conversation URL`, { host: window.location.hostname, path });
    }
};

const logDiscoveryFetch = (url: string, response: Response): void => {
    if (!isDiscoveryDiagnosticsEnabled()) {
        return;
    }
    const urlObj = new URL(url);
    if (isStaticAssetPath(urlObj.pathname)) {
        return;
    }

    log('info', '[DISCOVERY] POST', {
        path: urlObj.pathname,
        search: urlObj.search.slice(0, 150),
        status: response.status,
        contentType: response.headers.get('content-type'),
    });

    response
        .clone()
        .text()
        .then((text) => {
            if (text.length > 500) {
                log('info', '[DISCOVERY] Response', {
                    path: urlObj.pathname,
                    size: text.length,
                    preview: text.slice(0, 300),
                });
            }
            emitDiscoveryDumpFrame('DISCOVERY', urlObj.pathname, text);
        })
        .catch(() => {});
};

const logDiscoveryXhr = (url: string, responseText: string): void => {
    if (!isDiscoveryDiagnosticsEnabled()) {
        return;
    }
    const urlObj = new URL(url);
    if (isStaticAssetPath(urlObj.pathname) || responseText.length <= 500) {
        return;
    }
    log('info', '[DISCOVERY] XHR', {
        path: urlObj.pathname,
        search: urlObj.search.slice(0, 150),
        size: responseText.length,
        preview: responseText.slice(0, 300),
    });
    emitDiscoveryDumpFrame('XHR DISCOVERY', urlObj.pathname, responseText);
};

// ---------------------------------------------------------------------------
// Fetch/XHR capture helpers
// ---------------------------------------------------------------------------

const tryParseAndEmitConversation = (adapter: LLMPlatform, url: string, text: string, source: string): boolean => {
    const parsed = parseConversationData(adapter, text, url);
    if (!parsed?.conversation_id) {
        return false;
    }

    const payload = JSON.stringify(parsed);
    if (!shouldEmitCapturedPayload(adapter.name, url, payload)) {
        return true;
    }

    log('info', `${source} captured ${adapter.name} ${parsed.conversation_id}`);
    const attemptId = resolveAttemptIdForConversation(parsed.conversation_id, adapter.name);
    emitCapturePayload(url, payload, adapter.name, attemptId);
    emitNonChatGptStreamSnapshot(adapter, attemptId, parsed.conversation_id, parsed);
    if (adapter.name !== chatGPTAdapter.name && shouldEmitCompletionSignalForParsedData(adapter, url, parsed)) {
        emitResponseFinishedSignal(adapter, url);
    }
    return true;
};

const handleApiMatchFromFetch = (
    url: string,
    adapter: LLMPlatform,
    response: Response,
    deferredCompletionAdapter?: LLMPlatform,
): void => {
    const adapterName = adapter.name;
    if (shouldLogTransient(`api:match:${adapterName}:${safePathname(url)}`, 2500)) {
        log('info', `API match ${adapterName}`);
    }
    response
        .clone()
        .text()
        .then((text) => {
            const shouldCapture = shouldEmitCapturedPayload(adapterName, url, text);
            if (shouldCapture) {
                log('info', `API ${text.length}b ${adapterName}`);
            }

            const parsed = parseConversationData(adapter, text, url);
            const conversationId = resolveParsedConversationId(adapter, parsed, url);
            const attemptId = resolveAttemptIdForConversation(conversationId, adapterName);

            if (shouldCapture) {
                emitApiResponseDumpFrame(adapterName, url, text, attemptId, conversationId);
                emitCapturePayload(url, text, adapterName, attemptId);
                emitNonChatGptStreamSnapshot(adapter, attemptId, conversationId, parsed);
            }

            if (
                deferredCompletionAdapter &&
                shouldEmitCompletionSignalForParsedData(deferredCompletionAdapter, url, parsed)
            ) {
                emitResponseFinishedSignal(deferredCompletionAdapter, url);
                return;
            }
            if (
                adapterName !== chatGPTAdapter.name &&
                parsed?.conversation_id &&
                shouldEmitCompletionSignalForParsedData(adapter, url, parsed)
            ) {
                emitResponseFinishedSignal(adapter, url);
            }
        })
        .catch(() => {
            if (deferredCompletionAdapter && !shouldSuppressCompletionSignal(deferredCompletionAdapter, url)) {
                emitResponseFinishedSignal(deferredCompletionAdapter, url);
            }
            if (adapterName !== 'ChatGPT' || !safePathname(url).startsWith('/backend-api/f/conversation')) {
                log('warn', `API read err ${adapterName}`, { path: safePathname(url) });
            }
        });
};

const inspectAuxConversationFetch = (url: string, response: Response, adapter: LLMPlatform): void => {
    response
        .clone()
        .text()
        .then((text) => {
            log('info', 'aux response', { path: safePathname(url), status: response.status, size: text.length });
            if (!response.ok || text.length === 0) {
                return;
            }

            if (streamDumpEnabled && text.length > 100) {
                const conversationId = extractConversationIdFromAnyUrl(url);
                const attemptId = resolveAttemptIdForConversation(conversationId, adapter.name);
                emitApiResponseDumpFrame(adapter.name, url, text, attemptId, conversationId);
            }
            if (!tryParseAndEmitConversation(adapter, url, text, 'aux')) {
                if (shouldLogTransient(`aux:miss:${safePathname(url)}`, 2500)) {
                    log('info', 'aux parse miss', { path: safePathname(url) });
                }
            }
        })
        .catch(() => {
            log('info', 'aux read err', { path: safePathname(url) });
        });
};

const handleFetchInterception = (args: Parameters<typeof fetch>, response: Response): void => {
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    const apiAdapter = getPlatformAdapterByApiUrl(url);
    const completionAdapter = getPlatformAdapterByCompletionUrl(url);

    if (apiAdapter) {
        handleApiMatchFromFetch(url, apiAdapter, response, completionAdapter ?? undefined);
        return;
    }
    if (completionAdapter) {
        if (shouldEmitCompletionSignalForUrl(completionAdapter, url)) {
            emitResponseFinishedSignal(completionAdapter, url);
        }
        inspectAuxConversationFetch(url, response, completionAdapter);
        return;
    }
    if (url.includes('/backend-api/conversation/')) {
        logConversationSkip('API', url);
        return;
    }
    const method = args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET');
    if (
        method === 'POST' &&
        response.ok &&
        isDiscoveryModeHost(window.location.hostname) &&
        isDiscoveryDiagnosticsEnabled()
    ) {
        logDiscoveryFetch(url, response);
    }
    if (
        window.location.hostname.includes('gemini.google.com') &&
        safePathname(url).includes('/_/BardChatUi/data/') &&
        shouldLogTransient(`gemini:adapter-miss:fetch:${safePathname(url)}`, 8000)
    ) {
        log('warn', 'Gemini endpoint unmatched by adapter', { path: safePathname(url) });
    }
};

const processXhrApiMatch = (url: string, xhr: XMLHttpRequest, adapter: LLMPlatform | null): boolean => {
    if (!adapter) {
        return false;
    }
    try {
        log('info', `XHR API ${adapter.name}`);
        const parsed = parseConversationData(adapter, xhr.responseText, url);
        const conversationId = resolveParsedConversationId(adapter, parsed, url);
        const attemptId = resolveAttemptIdForConversation(conversationId, adapter.name);
        emitApiResponseDumpFrame(adapter.name, url, xhr.responseText, attemptId, conversationId);
        emitCapturePayload(url, xhr.responseText, adapter.name, attemptId);
        emitNonChatGptStreamSnapshot(adapter, attemptId, conversationId, parsed);
        if (
            adapter.name !== chatGPTAdapter.name &&
            parsed?.conversation_id &&
            shouldEmitCompletionSignalForParsedData(adapter, url, parsed)
        ) {
            emitResponseFinishedSignal(adapter, url);
        }
    } catch {
        log('error', 'XHR read err');
    }
    return true;
};

const processXhrAuxConversation = (url: string, xhr: XMLHttpRequest, adapter: LLMPlatform | null): void => {
    if (!adapter) {
        return;
    }
    log('info', 'aux response', { path: safePathname(url), status: xhr.status, size: xhr.responseText?.length ?? 0 });
    if (xhr.status < 200 || xhr.status >= 300 || !xhr.responseText) {
        return;
    }
    if (
        !tryParseAndEmitConversation(adapter, url, xhr.responseText, 'aux') &&
        shouldLogTransient(`aux:miss:${safePathname(url)}`, 2500)
    ) {
        log('info', 'aux parse miss', { path: safePathname(url) });
    }
};

const handleXhrLoad = (xhr: XMLHttpRequest, method: string): void => {
    const url = (xhr as any)._url;
    const adapter = getPlatformAdapterByApiUrl(url);
    const completionAdapter = getPlatformAdapterByCompletionUrl(url);

    if (processXhrApiMatch(url, xhr, adapter)) {
        return;
    }
    processXhrAuxConversation(url, xhr, completionAdapter);
    if (completionAdapter && !shouldSuppressCompletionSignal(completionAdapter, url)) {
        emitResponseFinishedSignal(completionAdapter, url);
        return;
    }
    if (url.includes('/backend-api/conversation/')) {
        logConversationSkip('XHR', url);
        return;
    }
    if (
        isDiscoveryModeHost(window.location.hostname) &&
        method === 'POST' &&
        xhr.status === 200 &&
        isDiscoveryDiagnosticsEnabled()
    ) {
        try {
            logDiscoveryXhr(url, xhr.responseText);
        } catch {}
    }
    if (
        window.location.hostname.includes('gemini.google.com') &&
        safePathname(url).includes('/_/BardChatUi/data/') &&
        !adapter &&
        !completionAdapter &&
        shouldLogTransient(`gemini:adapter-miss:xhr:${safePathname(url)}`, 8000)
    ) {
        log('warn', 'Gemini endpoint unmatched by adapter', { path: safePathname(url), method, status: xhr.status });
    }
};

// ---------------------------------------------------------------------------
// Session init / page snapshot / message handlers
// ---------------------------------------------------------------------------

export const shouldApplySessionInitToken = (existingToken: string | undefined, incomingToken: string): boolean => {
    if (typeof incomingToken !== 'string' || incomingToken.length === 0) {
        return false;
    }
    return !(typeof existingToken === 'string' && existingToken.length > 0);
};

const buildSnapshotResponse = (requestId: string, snapshot: unknown | null): PageSnapshotResponse =>
    snapshot
        ? { type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE', requestId, success: true, data: snapshot }
        : { type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE', requestId, success: false, error: 'NOT_FOUND' };

const isSnapshotRequestEvent = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin) {
        return null;
    }
    const message = event.data as PageSnapshotRequest;
    if (message?.type !== 'BLACKIYA_PAGE_SNAPSHOT_REQUEST' || typeof message.requestId !== 'string') {
        return null;
    }
    return message;
};

const isSameWindowOriginEvent = (event: MessageEvent) =>
    event.source === window && event.origin === window.location.origin;

const parseAttemptDisposedMessage = (event: MessageEvent): AttemptDisposedMessage | null => {
    if (!isSameWindowOriginEvent(event)) {
        return null;
    }
    const message = event.data as AttemptDisposedMessage & { __blackiyaToken?: string };
    if (message?.type !== 'BLACKIYA_ATTEMPT_DISPOSED' || typeof message.attemptId !== 'string') {
        return null;
    }
    const sessionToken = getSessionToken();
    if (sessionToken && message.__blackiyaToken !== sessionToken) {
        return null;
    }
    return message;
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export default defineContentScript({
    matches: [...SUPPORTED_PLATFORM_URLS],
    world: 'MAIN',
    runAt: 'document_start',
    main() {
        if ((window as any).__BLACKIYA_INTERCEPTED__) {
            log('info', 'already init (skip duplicate interceptor bootstrap)');
            return;
        }
        (window as any).__BLACKIYA_INTERCEPTED__ = true;

        if (!(window as any).__BLACKIYA_ORIGINALS__) {
            (window as any).__BLACKIYA_ORIGINALS__ = {
                fetch: window.fetch,
                XMLHttpRequestOpen: XMLHttpRequest.prototype.open,
                XMLHttpRequestSend: XMLHttpRequest.prototype.send,
                XMLHttpRequestSetRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
            };
        }

        const originalFetch = window.fetch;
        const emit = createStreamMonitorEmitter();
        const proactiveFetcher = new ProactiveFetcher();
        const proactiveSuccessAtByKey = new Map<string, number>();
        const proactiveHeadersByKey = new Map<string, HeaderRecord>();
        const proactiveSuccessCooldownMs = 20_000;
        const proactiveBackoffMs = [900, 1800, 3200, 5000, 7000, 9000, 12000, 15000];
        const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

        // ------------------------------------------------------------------
        // Proactive fetch
        // ------------------------------------------------------------------

        const tryFetchConversation = async (
            adapter: LLMPlatform,
            conversationId: string,
            attemptId: string,
            attempt: number,
            apiUrl: string,
            requestHeaders?: HeaderRecord,
        ) => {
            if (isAttemptDisposed(attemptId)) {
                return false;
            }
            try {
                const response = await originalFetch(apiUrl, { credentials: 'include', headers: requestHeaders });
                if (!response.ok) {
                    const path = safePathname(apiUrl);
                    if (shouldLogTransient(`fetch:status:${conversationId}:${path}:${response.status}`, 5000)) {
                        log('info', 'fetch response', { conversationId, ok: false, status: response.status, attempt });
                    }
                    return false;
                }
                const text = await response.text();
                try {
                    const parsed = adapter.parseInterceptedData(text, apiUrl);
                    if (!isCapturedConversationReady(adapter, parsed)) {
                        return false;
                    }
                    const payload = JSON.stringify(parsed);
                    if (!shouldEmitCapturedPayload(adapter.name, apiUrl, payload, 3000)) {
                        return false;
                    }
                    log('info', `fetched ${conversationId} ${text.length}b`, { path: safePathname(apiUrl) });
                    emitCapturePayload(apiUrl, payload, adapter.name, attemptId);
                    return true;
                } catch (error) {
                    if (shouldLogTransient(`fetch:parse:${adapter.name}:${safePathname(apiUrl)}`, 5000)) {
                        log('warn', `fetch parse err ${adapter.name}`, {
                            path: safePathname(apiUrl),
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                    return false;
                }
            } catch (error) {
                if (shouldLogTransient(`fetch:error:${conversationId}`, 5000)) {
                    log('warn', `fetch err ${conversationId}`, {
                        attempt,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
                return false;
            }
        };

        const runProactiveFetch = async (
            adapter: LLMPlatform,
            conversationId: string,
            key: string,
            attemptId: string,
        ) => {
            for (let attempt = 0; attempt < proactiveBackoffMs.length; attempt++) {
                if (isAttemptDisposed(attemptId)) {
                    return false;
                }
                await delay(proactiveBackoffMs[attempt]);
                const apiUrls = getApiUrlCandidates(adapter, conversationId);
                const requestHeaders = proactiveHeadersByKey.get(key);
                for (const apiUrl of apiUrls) {
                    const success = await tryFetchConversation(
                        adapter,
                        conversationId,
                        attemptId,
                        attempt + 1,
                        apiUrl,
                        requestHeaders,
                    );
                    if (success) {
                        setBoundedMapValue(
                            proactiveSuccessAtByKey,
                            key,
                            Date.now(),
                            MAX_INTERCEPTOR_DEDUPE_CACHE_ENTRIES,
                        );
                        return true;
                    }
                }
            }
            log('info', `fetch gave up ${conversationId}`);
            return false;
        };

        const fetchFullConversationWithBackoff = async (
            adapter: LLMPlatform,
            triggerUrl: string,
            requestHeaders?: HeaderRecord,
        ) => {
            if (!isFetchReady(adapter)) {
                return;
            }
            const conversationId = adapter.extractConversationIdFromUrl?.(triggerUrl);
            if (!conversationId) {
                return;
            }

            const key = `${adapter.name}:${conversationId}`;
            if (Date.now() - (proactiveSuccessAtByKey.get(key) ?? 0) < proactiveSuccessCooldownMs) {
                return;
            }

            const mergedHeaders = mergeHeaderRecords(proactiveHeadersByKey.get(key), requestHeaders);
            if (mergedHeaders) {
                proactiveHeadersByKey.set(key, mergedHeaders);
            }

            await proactiveFetcher.withInFlight(key, async () => {
                log('info', `trigger ${adapter.name} ${conversationId}`);
                const attemptId = resolveAttemptIdForConversation(conversationId, adapter.name);
                await runProactiveFetch(adapter, conversationId, key, attemptId);
                proactiveHeadersByKey.delete(key);
            });
        };

        // ------------------------------------------------------------------
        // Fetch interceptor
        // ------------------------------------------------------------------

        const emitFetchPromptLifecycle = (context: FetchInterceptorContext): void => {
            // ChatGPT path
            if (context.isChatGptPromptRequest && context.lifecycleAttemptId) {
                setBoundedMapValue(
                    latestAttemptIdByPlatform,
                    chatGPTAdapter.name,
                    context.lifecycleAttemptId,
                    MAX_INTERCEPTOR_ATTEMPT_BINDINGS,
                );
                disposedAttemptIds.delete(context.lifecycleAttemptId);
                bindAttemptToConversation(context.lifecycleAttemptId, context.lifecycleConversationId);
                if (context.lifecycleConversationId) {
                    emitConversationIdResolvedSignal(context.lifecycleAttemptId, context.lifecycleConversationId);
                }
                emitLifecycleSignal(context.lifecycleAttemptId, 'prompt-sent', context.lifecycleConversationId);
            }

            // Non-ChatGPT path
            if (!context.shouldEmitNonChatLifecycle || !context.fetchApiAdapter) {
                return;
            }
            const adapter = context.fetchApiAdapter;
            const attemptId =
                context.nonChatAttemptId ??
                resolveAttemptIdForConversation(context.nonChatConversationId, adapter.name);
            if (!attemptId) {
                return;
            }

            emitLifecycleSignal(attemptId, 'prompt-sent', context.nonChatConversationId, adapter.name);
            if (adapter.name !== 'Gemini') {
                emitLifecycleSignal(attemptId, 'streaming', context.nonChatConversationId, adapter.name);
            }

            if (adapter.name === 'Grok' && shouldLogTransient(`grok:fetch:request:${attemptId}`, 3000)) {
                log('info', 'Grok fetch request intercepted', {
                    attemptId,
                    conversationId: context.nonChatConversationId ?? null,
                    method: context.outgoingMethod,
                    path: context.outgoingPath,
                });
            }
        };

        const maybeMonitorFetchStreams = (context: FetchInterceptorContext, response: Response): void => {
            const contentType = response.headers.get('content-type') ?? '';

            if (context.isChatGptPromptRequest && contentType.includes('text/event-stream')) {
                void monitorChatGptSseLifecycle(
                    response.clone(),
                    context.lifecycleAttemptId ??
                        resolveAttemptIdForConversation(context.lifecycleConversationId, chatGPTAdapter.name),
                    emit,
                    context.lifecycleConversationId,
                );
            }

            if (
                context.isNonChatGptApiRequest &&
                context.fetchApiAdapter?.name === 'Gemini' &&
                context.nonChatAttemptId
            ) {
                void monitorGeminiResponseStream(
                    response.clone(),
                    context.nonChatAttemptId,
                    emit,
                    context.nonChatConversationId,
                );
            }

            if (
                context.isNonChatGptApiRequest &&
                context.fetchApiAdapter?.name === 'Grok' &&
                context.nonChatAttemptId &&
                isGrokStreamingEndpoint(context.outgoingUrl)
            ) {
                if (shouldLogTransient(`grok:fetch:response:${context.nonChatAttemptId}`, 3000)) {
                    log('info', 'Grok fetch response intercepted', {
                        attemptId: context.nonChatAttemptId,
                        conversationId: context.nonChatConversationId ?? null,
                        status: response.status,
                        contentType,
                        path: safePathname(context.outgoingUrl),
                    });
                }
                void monitorGrokResponseStream(
                    response.clone(),
                    context.nonChatAttemptId,
                    emit,
                    context.nonChatConversationId,
                    context.outgoingUrl,
                    context.shouldEmitNonChatLifecycle,
                );
            }
        };

        const interceptFetchRequest = async (args: Parameters<typeof fetch>): Promise<Response> => {
            const url = args[0] instanceof Request ? args[0].url : String(args[0]);
            const context = createFetchInterceptorContext(args, {
                getRequestUrl: (req) => (req instanceof Request ? req.url : String(req)),
                getRequestMethod: (a) => a[1]?.method || (a[0] instanceof Request ? a[0].method : 'GET'),
                getPlatformAdapterByApiUrl,
                chatGptPlatformName: chatGPTAdapter.name,
                shouldEmitNonChatLifecycleForRequest,
                resolveRequestConversationId,
                peekAttemptIdForConversation,
                resolveAttemptIdForConversation,
                resolveLifecycleConversationId,
                safePathname,
            });
            emitFetchPromptLifecycle(context);

            const response = await originalFetch(...args);

            // Gemini discovery logging
            if (
                isDiscoveryDiagnosticsEnabled() &&
                window.location.hostname.includes('gemini.google.com') &&
                context.outgoingMethod === 'POST' &&
                response.ok
            ) {
                log('info', '[DISCOVERY] Gemini fetch POST', {
                    path: safePathname(url),
                    status: response.status,
                    contentType: response.headers.get('content-type') ?? '',
                });
            }

            maybeMonitorFetchStreams(context, response);

            // Proactive completion backoff
            const completionAdapter = getPlatformAdapterByCompletionUrl(url);
            if (completionAdapter) {
                void fetchFullConversationWithBackoff(
                    completionAdapter,
                    url,
                    extractForwardableHeadersFromFetchArgs(args),
                );
            }

            handleFetchInterception(args, response);
            return response;
        };

        window.fetch = createFetchInterceptor(originalFetch, async (input, init) =>
            interceptFetchRequest([input, init] as Parameters<typeof fetch>),
        );

        // ------------------------------------------------------------------
        // XHR interceptor
        // ------------------------------------------------------------------

        const XHR = window.XMLHttpRequest;
        const originalOpen = XHR.prototype.open;
        const originalSend = XHR.prototype.send;
        const originalSetRequestHeader = XHR.prototype.setRequestHeader;

        XHR.prototype.open = function (_method: string, url: string | URL, ...args: any[]) {
            notifyXhrOpen(_method, String(url), (method, requestUrl) => {
                (this as any)._url = requestUrl;
                (this as any)._method = method;
                (this as any)._headers = {};
            });
            return originalOpen.apply(this, [_method, url, ...args] as any);
        };

        XHR.prototype.setRequestHeader = function (header: string, value: string) {
            const existing = ((this as any)._headers as Record<string, string> | undefined) ?? {};
            existing[String(header).toLowerCase()] = String(value);
            (this as any)._headers = existing;
            return originalSetRequestHeader.call(this, header, value);
        };

        const emitXhrRequestLifecycle = (xhr: XMLHttpRequest, context: XhrLifecycleContext) => {
            if (!context.shouldEmitNonChatLifecycle || !context.requestAdapter) {
                return;
            }
            const attemptId =
                context.attemptId ??
                resolveAttemptIdForConversation(context.conversationId, context.requestAdapter.name);
            if (!attemptId) {
                return;
            }
            if (!shouldEmitXhrRequestLifecycle({ ...context, attemptId })) {
                return;
            }

            emitLifecycleSignal(attemptId, 'prompt-sent', context.conversationId, context.requestAdapter.name);

            if (context.requestAdapter.name === 'Gemini') {
                wireGeminiXhrProgressMonitor(xhr, attemptId, emit, context.conversationId, context.requestUrl);
                return;
            }
            if (context.requestAdapter.name === 'Grok' && context.conversationId) {
                wireGrokXhrProgressMonitor(xhr, attemptId, emit, context.conversationId);
                if (shouldLogTransient(`grok:xhr:request:${attemptId}`, 3000)) {
                    log('info', 'Grok XHR request intercepted', {
                        attemptId,
                        conversationId: context.conversationId,
                        method: context.methodUpper,
                        path: safePathname(context.requestUrl),
                    });
                }
                return;
            }
            if (context.requestAdapter && context.conversationId) {
                emitLifecycleSignal(attemptId, 'streaming', context.conversationId, context.requestAdapter.name);
            }
        };

        const registerXhrLoadHandler = (xhr: XMLHttpRequest, methodUpper: string): void => {
            xhr.addEventListener('load', function () {
                const self = this as XMLHttpRequest;
                const xhrUrl = ((self as any)._url as string | undefined) ?? '';

                // Grok XHR response logging
                if (methodUpper === 'POST') {
                    const xhrAdapter = getPlatformAdapterByApiUrl(xhrUrl);
                    if (xhrAdapter?.name === 'Grok') {
                        const conversationId = resolveRequestConversationId(xhrAdapter, xhrUrl);
                        const attemptId = resolveAttemptIdForConversation(conversationId, 'Grok');
                        if (shouldLogTransient(`grok:xhr:response:${attemptId}`, 3000)) {
                            log('info', 'Grok XHR response intercepted', {
                                attemptId,
                                conversationId: conversationId ?? null,
                                status: self.status,
                                size: self.responseText?.length ?? 0,
                                path: safePathname(xhrUrl),
                            });
                        }
                    }
                }

                // Gemini XHR discovery
                if (
                    isDiscoveryDiagnosticsEnabled() &&
                    window.location.hostname.includes('gemini.google.com') &&
                    methodUpper === 'POST' &&
                    self.status === 200
                ) {
                    log('info', '[DISCOVERY] Gemini XHR POST', {
                        path: safePathname(xhrUrl),
                        status: self.status,
                        size: self.responseText?.length ?? 0,
                    });
                }

                // Proactive completion fetch
                const completionAdapter = getPlatformAdapterByCompletionUrl(xhrUrl);
                if (completionAdapter) {
                    void fetchFullConversationWithBackoff(
                        completionAdapter,
                        xhrUrl,
                        toForwardableHeaderRecord((self as any)._headers),
                    );
                }

                handleXhrLoad(self, methodUpper);
            });
        };

        XHR.prototype.send = function (body?: any) {
            const xhr = this as XMLHttpRequest;
            const context = buildXhrLifecycleContext(xhr, {
                getPlatformAdapterByApiUrl,
                chatGptPlatformName: chatGPTAdapter.name,
                shouldEmitNonChatLifecycleForRequest,
                resolveRequestConversationId,
                peekAttemptIdForConversation,
            });
            emitXhrRequestLifecycle(xhr, context);
            registerXhrLoadHandler(xhr, context.methodUpper);
            return originalSend.call(this, body);
        };

        log('info', 'init', { host: window.location.hostname, runtimeTag: INTERCEPTOR_RUNTIME_TAG });

        // ------------------------------------------------------------------
        // Window message handlers (page snapshot, session, disposal, dump config)
        // ------------------------------------------------------------------

        if (!(window as any).__blackiya) {
            const requestJson = createWindowJsonRequester(window, {
                requestType: BLACKIYA_GET_JSON_REQUEST,
                responseType: BLACKIYA_GET_JSON_RESPONSE,
                timeoutMs: 5000,
            });

            window.addEventListener('message', (event: MessageEvent) => {
                const message = isSnapshotRequestEvent(event);
                if (!message || resolveTokenValidationFailureReason(message) !== null) {
                    return;
                }
                const conversationId = typeof message.conversationId === 'string' ? message.conversationId : '';
                const snapshot = conversationId
                    ? getPageConversationSnapshot(conversationId, getRawCaptureHistory)
                    : null;
                window.postMessage(
                    stampToken(buildSnapshotResponse(message.requestId, snapshot)),
                    window.location.origin,
                );
            });

            window.addEventListener('message', (event: MessageEvent) => {
                const message = parseAttemptDisposedMessage(event);
                if (!message) {
                    return;
                }
                cleanupDisposedAttemptState(message.attemptId, {
                    disposedAttemptIds,
                    streamDumpFrameCountByAttempt,
                    streamDumpLastTextByAttempt,
                    latestAttemptIdByPlatform,
                    attemptByConversationId,
                });
            });

            window.addEventListener('message', (event: MessageEvent) => {
                if (event.source !== window || event.origin !== window.location.origin) {
                    return;
                }
                const message = event.data as StreamDumpConfigMessage & { __blackiyaToken?: string };
                if (message?.type !== 'BLACKIYA_STREAM_DUMP_CONFIG' || typeof message.enabled !== 'boolean') {
                    return;
                }
                const sessionToken = getSessionToken();
                if (sessionToken && message.__blackiyaToken !== sessionToken) {
                    return;
                }
                streamDumpEnabled = message.enabled;
                if (!streamDumpEnabled) {
                    streamDumpFrameCountByAttempt.clear();
                    streamDumpLastTextByAttempt.clear();
                }
            });

            window.addEventListener('message', (event: MessageEvent) => {
                if (!isSameWindowOriginEvent(event)) {
                    return;
                }
                const message = event.data as SessionInitMessage;
                if (message?.type !== 'BLACKIYA_SESSION_INIT' || typeof message.token !== 'string') {
                    return;
                }
                if (shouldApplySessionInitToken(getSessionToken(), message.token)) {
                    setSessionToken(message.token);
                }
            });

            (window as any).__blackiya = {
                getJSON: () => requestJson(JSON_FORMAT_ORIGINAL),
                getCommonJSON: () => requestJson(JSON_FORMAT_COMMON),
            };
        }
    },
});

export { setBoundedMapValue };
