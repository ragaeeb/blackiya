import { chatGPTAdapter } from '@/platforms/chatgpt';
import { SUPPORTED_PLATFORM_URLS } from '@/platforms/constants';
import { getPlatformAdapterByApiUrl, getPlatformAdapterByCompletionUrl } from '@/platforms/factory';
import type { LLMPlatform } from '@/platforms/types';
import { isConversationReady } from '@/utils/conversation-readiness';
import { shouldEmitGeminiCompletion, shouldEmitGeminiLifecycle } from '@/utils/gemini-request-classifier';
import { extractGeminiStreamSignalsFromBuffer } from '@/utils/gemini-stream-parser';
import { shouldEmitGrokCompletion, shouldEmitGrokLifecycle } from '@/utils/grok-request-classifier';
import { extractGrokStreamSignalsFromBuffer } from '@/utils/grok-stream-parser';
import {
    extractForwardableHeadersFromFetchArgs,
    type HeaderRecord,
    mergeHeaderRecords,
    toForwardableHeaderRecord,
} from '@/utils/proactive-fetch-headers';
import {
    type AttemptDisposedMessage,
    type CaptureInterceptedMessage as CapturePayload,
    type ConversationIdResolvedMessage,
    createAttemptId,
    type LogEntryMessage as InterceptorLogPayload,
    type ResponseFinishedMessage as ResponseFinishedSignal,
    type ResponseLifecycleMessage as ResponseLifecycleSignal,
    type StreamDeltaMessage as ResponseStreamDeltaSignal,
    type StreamDumpConfigMessage,
    type StreamDumpFrameMessage,
} from '@/utils/protocol/messages';
import type { ConversationData } from '@/utils/types';

interface RawCaptureSnapshot {
    __blackiyaSnapshotType: 'raw-capture';
    data: string;
    url: string;
    platform: string;
    conversationId?: string;
}

interface PageSnapshotRequest {
    type: 'BLACKIYA_PAGE_SNAPSHOT_REQUEST';
    requestId: string;
    conversationId: string;
}

interface PageSnapshotResponse {
    type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE';
    requestId: string;
    success: boolean;
    data?: unknown;
    error?: string;
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
let streamDumpEnabled = false;
const INTERCEPTOR_RUNTIME_TAG = 'v2.1.1-grok-stream';
type GeminiXhrStreamState = {
    attemptId: string;
    seedConversationId?: string;
    lastLength: number;
    buffer: string;
    seenPayloads: Set<string>;
    seenPayloadOrder: string[];
    emittedText: Set<string>;
    emittedTextOrder: string[];
    emittedTitles: Set<string>;
    emittedStreaming: boolean;
};

type GrokXhrStreamState = {
    attemptId: string;
    requestUrl: string;
    seedConversationId?: string;
    lastLength: number;
    buffer: string;
    seenPayloads: Set<string>;
    seenPayloadOrder: string[];
    emittedSignals: Set<string>;
    emittedSignalOrder: string[];
    emittedStreaming: boolean;
};

function log(level: 'info' | 'warn' | 'error', message: string, data?: any) {
    // Keep page-console output for warnings/errors while avoiding info-level floods.
    const displayData = data ? ` ${JSON.stringify(data)}` : '';
    if (level === 'error') {
        console.error(message + displayData);
    } else if (level === 'warn') {
        console.warn(message + displayData);
    }

    // Send to content script for persistence
    const payload: InterceptorLogPayload = {
        type: 'LLM_LOG_ENTRY',
        payload: {
            level,
            message,
            data: data ? [data] : [],
            context: 'interceptor',
        },
    };

    queueLogMessage(payload);
    window.postMessage(payload, window.location.origin);
}

function queueInterceptedMessage(payload: CapturePayload) {
    const queue = ((window as any).__BLACKIYA_CAPTURE_QUEUE__ as CapturePayload[] | undefined) ?? [];
    queue.push(payload);
    // Prevent unbounded growth if the content script initializes late
    if (queue.length > 50) {
        queue.splice(0, queue.length - 50);
    }
    (window as any).__BLACKIYA_CAPTURE_QUEUE__ = queue;
    cacheRawCapture(payload);
}

function cacheRawCapture(payload: CapturePayload): void {
    const history = ((window as any).__BLACKIYA_RAW_CAPTURE_HISTORY__ as CapturePayload[] | undefined) ?? [];
    history.push(payload);
    if (history.length > 30) {
        history.splice(0, history.length - 30);
    }
    (window as any).__BLACKIYA_RAW_CAPTURE_HISTORY__ = history;
}

function getRawCaptureHistory(): CapturePayload[] {
    const history = (window as any).__BLACKIYA_RAW_CAPTURE_HISTORY__;
    if (!Array.isArray(history)) {
        return [];
    }
    return history as CapturePayload[];
}

function buildRawCaptureSnapshot(conversationId: string): RawCaptureSnapshot | null {
    const history = getRawCaptureHistory();
    for (let i = history.length - 1; i >= 0; i--) {
        const item = history[i];
        if (!item || typeof item.url !== 'string' || typeof item.data !== 'string') {
            continue;
        }

        const urlHasId = item.url.includes(conversationId);
        const dataHasId = item.data.includes(conversationId);
        if (!urlHasId && !dataHasId) {
            continue;
        }

        return {
            __blackiyaSnapshotType: 'raw-capture',
            url: item.url,
            data: item.data,
            platform: item.platform,
            conversationId,
        };
    }
    return null;
}

function queueLogMessage(payload: InterceptorLogPayload) {
    const queue = ((window as any).__BLACKIYA_LOG_QUEUE__ as InterceptorLogPayload[] | undefined) ?? [];
    queue.push(payload);
    if (queue.length > 100) {
        queue.splice(0, queue.length - 100);
    }
    (window as any).__BLACKIYA_LOG_QUEUE__ = queue;
}

function safePathname(url: string): string {
    try {
        return new URL(url, window.location.origin).pathname;
    } catch {
        return url.slice(0, 120);
    }
}

function detectPlatformFromHostname(): string {
    const hostname = window.location.hostname;
    if (hostname.includes('gemini')) {
        return 'Gemini';
    }
    if (hostname.includes('grok')) {
        return 'Grok';
    }
    if (hostname.includes('chatgpt')) {
        return 'ChatGPT';
    }
    return 'Discovery';
}

function isDiscoveryDiagnosticsEnabled(): boolean {
    try {
        return window.localStorage.getItem('blackiya.discovery') === '1';
    } catch {
        return false;
    }
}

function emitDiscoveryDumpFrame(label: string, path: string, text: string): void {
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
}

function shouldEmitCapturedPayload(adapterName: string, url: string, payload: string, intervalMs = 5000): boolean {
    const path = safePathname(url);
    const suffix = payload.length > 128 ? payload.slice(payload.length - 128) : payload;
    const key = `${adapterName}:${path}:${payload.length}:${suffix}`;
    const now = Date.now();
    const last = capturePayloadCache.get(key) ?? 0;
    if (now - last < intervalMs) {
        return false;
    }
    capturePayloadCache.set(key, now);
    return true;
}

function logConversationSkip(channel: 'API' | 'XHR', url: string): void {
    const path = safePathname(url);
    const key = `${channel}:skip:${path}`;
    if (!shouldLogTransient(key, 2500)) {
        return;
    }
    log('info', `${channel} skip conversation URL`, {
        host: window.location.hostname,
        path,
    });
}

function shouldLogTransient(key: string, intervalMs = 2000): boolean {
    const now = Date.now();
    const last = transientLogCache.get(key) ?? 0;
    if (now - last < intervalMs) {
        return false;
    }
    transientLogCache.set(key, now);
    return true;
}

function bindAttemptToConversation(attemptId: string | null | undefined, conversationId: string | undefined): void {
    if (!attemptId || !conversationId) {
        return;
    }
    attemptByConversationId.set(conversationId, attemptId);
}

function toAttemptPrefix(platformName: string): string {
    return platformName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function resolveAttemptIdForConversation(conversationId?: string, platformName = chatGPTAdapter.name): string {
    const platformKey = platformName || chatGPTAdapter.name;
    if (conversationId) {
        const bound = attemptByConversationId.get(conversationId);
        if (bound) {
            return bound;
        }
    }
    const latestAttemptId = latestAttemptIdByPlatform.get(platformKey);
    if (latestAttemptId && !disposedAttemptIds.has(latestAttemptId)) {
        if (conversationId) {
            bindAttemptToConversation(latestAttemptId, conversationId);
        }
        return latestAttemptId;
    }
    if (latestAttemptId && disposedAttemptIds.has(latestAttemptId)) {
        latestAttemptIdByPlatform.delete(platformKey);
    }
    const created = createAttemptId(toAttemptPrefix(platformKey));
    latestAttemptIdByPlatform.set(platformKey, created);
    if (conversationId) {
        bindAttemptToConversation(created, conversationId);
    }
    return created;
}

function emitConversationIdResolvedSignal(attemptId: string, conversationId: string, platformOverride?: string): void {
    const key = `${attemptId}:${conversationId}`;
    const now = Date.now();
    const last = conversationResolvedSignalCache.get(key) ?? 0;
    if (now - last < 1200) {
        return;
    }
    conversationResolvedSignalCache.set(key, now);
    bindAttemptToConversation(attemptId, conversationId);

    const payload: ConversationIdResolvedMessage = {
        type: 'BLACKIYA_CONVERSATION_ID_RESOLVED',
        platform: platformOverride ?? chatGPTAdapter.name,
        attemptId,
        conversationId,
    };
    window.postMessage(payload, window.location.origin);
}

function isAttemptDisposed(attemptId: string | undefined): boolean {
    return !!attemptId && disposedAttemptIds.has(attemptId);
}

function emitResponseFinishedSignal(adapter: LLMPlatform, url: string): void {
    const conversationId = adapter.extractConversationIdFromUrl?.(url) ?? undefined;
    const attemptId = resolveAttemptIdForConversation(conversationId, adapter.name);
    const dedupeKey = `${adapter.name}:${conversationId ?? safePathname(url)}`;
    const now = Date.now();
    const last = completionSignalCache.get(dedupeKey) ?? 0;
    if (now - last < 1500) {
        return;
    }
    completionSignalCache.set(dedupeKey, now);

    const payload: ResponseFinishedSignal = {
        type: 'BLACKIYA_RESPONSE_FINISHED',
        platform: adapter.name,
        attemptId,
        conversationId,
    };
    window.postMessage(payload, window.location.origin);
    log('info', 'response finished hint', {
        platform: adapter.name,
        conversationId: conversationId ?? null,
        path: safePathname(url),
    });
}

function extractConversationIdFromChatGptUrl(url: string): string | undefined {
    const match = url.match(/\/c\/([a-f0-9-]{36})/i);
    return match?.[1];
}

function extractConversationIdFromAnyUrl(url: string): string | undefined {
    const match = url.match(/\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i);
    return match?.[1];
}

function extractConversationIdFromRequestBody(args: Parameters<typeof fetch>): string | undefined {
    const initBody = args[1]?.body;
    if (typeof initBody !== 'string') {
        return undefined;
    }

    try {
        const parsed = JSON.parse(initBody);
        const conversationId =
            typeof parsed?.conversation_id === 'string'
                ? parsed.conversation_id
                : typeof parsed?.conversationId === 'string'
                  ? parsed.conversationId
                  : undefined;
        if (!conversationId || conversationId === 'null') {
            return undefined;
        }
        return /^[a-f0-9-]{36}$/i.test(conversationId) ? conversationId : undefined;
    } catch {
        return undefined;
    }
}

function resolveLifecycleConversationId(args: Parameters<typeof fetch>): string | undefined {
    return extractConversationIdFromRequestBody(args) ?? extractConversationIdFromChatGptUrl(window.location.href);
}

function resolveRequestConversationId(adapter: LLMPlatform, requestUrl: string): string | undefined {
    return (
        adapter.extractConversationIdFromUrl?.(requestUrl) ??
        adapter.extractConversationId(window.location.href) ??
        undefined
    );
}

function isGeminiTitlesEndpoint(url: string): boolean {
    return /\/_\/BardChatUi\/data\/batchexecute/i.test(url) && /[?&]rpcids=MaZiqc(?:&|$)/i.test(url);
}

function shouldEmitNonChatLifecycleForRequest(adapter: LLMPlatform, url: string): boolean {
    if (adapter.name === 'Gemini') {
        const allowed = shouldEmitGeminiLifecycle(url);
        if (!allowed && shouldLogTransient(`gemini:lifecycle-suppressed:${safePathname(url)}`, 8000)) {
            log('info', 'Gemini lifecycle suppressed for non-generation endpoint', {
                path: safePathname(url),
            });
        }
        return allowed;
    }
    if (adapter.name === 'Grok') {
        const allowed = shouldEmitGrokLifecycle(url);
        if (!allowed && shouldLogTransient(`grok:lifecycle-suppressed:${safePathname(url)}`, 8000)) {
            log('info', 'Grok lifecycle suppressed for non-generation endpoint', {
                path: safePathname(url),
            });
        }
        return allowed;
    }
    return true;
}

function shouldEmitCompletionSignalForUrl(adapter: LLMPlatform, url: string): boolean {
    if (adapter.name === 'Gemini') {
        if (isGeminiTitlesEndpoint(url)) {
            return false;
        }
        return shouldEmitGeminiCompletion(url);
    }
    if (adapter.name === 'Grok') {
        return shouldEmitGrokCompletion(url);
    }
    return true;
}

function shouldSuppressCompletionSignal(adapter: LLMPlatform, url: string): boolean {
    return !shouldEmitCompletionSignalForUrl(adapter, url);
}

function shouldEmitLifecycleSignal(phase: ResponseLifecycleSignal['phase'], conversationId?: string): boolean {
    const key = `${phase}:${conversationId ?? 'unknown'}`;
    const now = Date.now();
    const last = lifecycleSignalCache.get(key) ?? 0;
    if (now - last < 300) {
        return false;
    }
    lifecycleSignalCache.set(key, now);
    return true;
}

function emitLifecycleSignal(
    attemptId: string,
    phase: ResponseLifecycleSignal['phase'],
    conversationId?: string,
    platformOverride?: string,
): void {
    if (!shouldEmitLifecycleSignal(phase, conversationId)) {
        return;
    }

    if (isAttemptDisposed(attemptId)) {
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
    window.postMessage(payload, window.location.origin);
    log('info', 'lifecycle signal', {
        platform,
        phase,
        conversationId: conversationId ?? null,
    });
}

function emitTitleResolvedSignal(
    attemptId: string,
    conversationId: string,
    title: string,
    platformOverride?: string,
): void {
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
    window.postMessage(payload, window.location.origin);
    log('info', 'title resolved from stream', { conversationId, title });
}

function extractTitleFromSsePayload(dataPayload: string): string | null {
    try {
        const parsed = JSON.parse(dataPayload);
        if (
            parsed?.type === 'title_generation' &&
            typeof parsed?.title === 'string' &&
            parsed.title.trim().length > 0
        ) {
            return parsed.title.trim();
        }
    } catch {
        // Not JSON or not a title frame
    }
    return null;
}

function emitStreamDeltaSignal(
    attemptId: string,
    conversationId: string | undefined,
    text: string,
    platformOverride?: string,
): void {
    const normalized = text.replace(/\r\n/g, '\n');
    const trimmed = normalized.trim();
    if (trimmed.length === 0 || /^v\d+$/i.test(trimmed)) {
        return;
    }
    if (isAttemptDisposed(attemptId)) {
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
    window.postMessage(payload, window.location.origin);
}

function emitStreamDumpFrame(
    attemptId: string,
    conversationId: string | undefined,
    kind: StreamDumpFrameMessage['kind'],
    text: string,
    chunkBytes?: number,
    platformOverride?: string,
): void {
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
    streamDumpLastTextByAttempt.set(attemptId, normalized);

    const frameIndex = (streamDumpFrameCountByAttempt.get(attemptId) ?? 0) + 1;
    streamDumpFrameCountByAttempt.set(attemptId, frameIndex);

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

    window.postMessage(payload, window.location.origin);
}

/**
 * Emit a stream dump frame for a captured API response (Gemini, Grok, etc.).
 * Includes the URL path and response body for debugging.
 */
function emitApiResponseDumpFrame(
    adapterName: string,
    url: string,
    responseText: string,
    attemptId: string,
    conversationId?: string,
): void {
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
}

function extractAssistantTextSnapshotFromSseBuffer(sseBuffer: string): string | null {
    const parsed = chatGPTAdapter.parseInterceptedData(sseBuffer, 'https://chatgpt.com/backend-api/f/conversation');
    if (!parsed) {
        return null;
    }

    const assistantMessages = Object.values(parsed.mapping)
        .map((node) => node.message)
        .filter(
            (message): message is NonNullable<(typeof parsed.mapping)[string]['message']> =>
                !!message && message.author.role === 'assistant',
        );

    if (assistantMessages.length === 0) {
        return null;
    }

    const latest = assistantMessages[assistantMessages.length - 1];
    const parts = latest.content.parts ?? [];
    const text = parts.filter((part) => typeof part === 'string').join('');
    const normalized = text.trim();
    if (normalized.length === 0 || /^v\d+$/i.test(normalized)) {
        return null;
    }
    return normalized;
}

function isLikelyReadableToken(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length < 2 || trimmed.length > 4000) {
        return false;
    }
    if (/^v\d+$/i.test(trimmed)) {
        return false;
    }
    if (/^[a-f0-9-]{24,}$/i.test(trimmed)) {
        return false;
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return false;
    }
    if (/^[[\]{}(),:;._\-+=/\\|`~!@#$%^&*<>?]+$/.test(trimmed)) {
        return false;
    }
    return true;
}

function collectLikelyTextValues(node: unknown, out: string[], depth = 0): void {
    if (depth > 8 || out.length > 80) {
        return;
    }

    if (typeof node === 'string') {
        if (isLikelyReadableToken(node)) {
            out.push(node.trim());
        }
        return;
    }

    if (!node || typeof node !== 'object') {
        return;
    }

    if (Array.isArray(node)) {
        for (const child of node) {
            collectLikelyTextValues(child, out, depth + 1);
        }
        return;
    }

    const obj = node as Record<string, unknown>;
    const preferredKeys = ['text', 'delta', 'content', 'message', 'output_text', 'token', 'part'];
    for (const key of preferredKeys) {
        if (key in obj) {
            collectLikelyTextValues(obj[key], out, depth + 1);
        }
    }

    for (const value of Object.values(obj)) {
        collectLikelyTextValues(value, out, depth + 1);
    }
}

function extractLikelyTextFromSsePayload(payload: string): string[] {
    try {
        const parsed = JSON.parse(payload);
        const values: string[] = [];
        collectLikelyTextValues(parsed, values);
        const deduped: string[] = [];
        const seen = new Set<string>();
        for (const value of values) {
            if (seen.has(value)) {
                continue;
            }
            seen.add(value);
            deduped.push(value);
        }
        return deduped;
    } catch {
        return [];
    }
}

function trimGeminiPayloadHistory(seenPayloadOrder: string[], seenPayloads: Set<string>): void {
    const maxEntries = 220;
    while (seenPayloadOrder.length > maxEntries) {
        const oldest = seenPayloadOrder.shift();
        if (oldest) {
            seenPayloads.delete(oldest);
        }
    }
}

function trimGeminiDeltaHistory(emittedTextOrder: string[], emittedText: Set<string>): void {
    const maxEntries = 260;
    while (emittedTextOrder.length > maxEntries) {
        const oldest = emittedTextOrder.shift();
        if (oldest) {
            emittedText.delete(oldest);
        }
    }
}

async function consumeReadableStreamChunks(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    attemptId: string,
    onChunk: (chunkText: string, chunkBytes: number) => void | Promise<void>,
): Promise<void> {
    while (true) {
        if (isAttemptDisposed(attemptId)) {
            return;
        }
        const { value, done } = await reader.read();
        if (done) {
            return;
        }
        if (!value || value.length === 0) {
            continue;
        }
        const chunkText = decoder.decode(value, { stream: true });
        if (chunkText.length === 0) {
            continue;
        }
        await onChunk(chunkText, value.length);
    }
}

async function monitorGeminiResponseStream(
    response: Response,
    attemptId: string,
    seedConversationId: string | undefined,
): Promise<void> {
    if (!response.body || isAttemptDisposed(attemptId)) {
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let conversationId = seedConversationId;
    let emittedStreaming = false;
    const seenPayloads = new Set<string>();
    const seenPayloadOrder: string[] = [];
    const emittedText = new Set<string>();
    const emittedTextOrder: string[] = [];
    const emittedTitles = new Set<string>();

    if (conversationId) {
        emitConversationIdResolvedSignal(attemptId, conversationId, 'Gemini');
    }
    if (shouldLogTransient(`gemini:fetch-stream:start:${attemptId}`, 8000)) {
        log('info', 'Gemini fetch stream monitor start', {
            attemptId,
            conversationId: conversationId ?? null,
        });
    }

    try {
        await consumeReadableStreamChunks(reader, decoder, attemptId, (chunkText, chunkBytes) => {
            const result = processGeminiFetchStreamChunk(
                attemptId,
                conversationId,
                emittedStreaming,
                buffer,
                chunkText,
                chunkBytes,
                seenPayloads,
                seenPayloadOrder,
                emittedText,
                emittedTextOrder,
                emittedTitles,
            );
            conversationId = result.conversationId;
            emittedStreaming = result.emittedStreaming;
            buffer = result.buffer;
        });
    } catch {
        // Ignore monitor read errors; completion + canonical capture path remains authoritative.
    } finally {
        reader.releaseLock();
    }
}

function processGeminiFetchStreamChunk(
    attemptId: string,
    conversationId: string | undefined,
    emittedStreaming: boolean,
    buffer: string,
    chunkText: string,
    chunkBytes: number,
    seenPayloads: Set<string>,
    seenPayloadOrder: string[],
    emittedText: Set<string>,
    emittedTextOrder: string[],
    emittedTitles: Set<string>,
): { conversationId: string | undefined; emittedStreaming: boolean; buffer: string } {
    logGeminiFetchChunkProgress(attemptId, conversationId, chunkBytes);
    buffer = appendGeminiBufferChunk(buffer, chunkText);
    emitStreamDumpFrame(attemptId, conversationId, 'delta', chunkText, chunkBytes, 'Gemini');

    const {
        conversationId: parsedConversationId,
        textCandidates,
        titleCandidates,
    } = extractGeminiStreamSignalsFromBuffer(buffer, seenPayloads);

    syncGeminiSeenPayloadOrderFromSet(seenPayloadOrder, seenPayloads);
    conversationId = resolveGeminiConversationFromFetchStream(attemptId, conversationId, parsedConversationId);
    emittedStreaming = emitGeminiStreamingLifecycleFromFetch(
        attemptId,
        conversationId,
        emittedStreaming,
        textCandidates,
        chunkText,
    );

    emitGeminiFetchTextCandidates(attemptId, conversationId, textCandidates, emittedText, emittedTextOrder);
    emitGeminiTitleCandidates(attemptId, conversationId, titleCandidates, emittedTitles);

    return { conversationId, emittedStreaming, buffer };
}

function logGeminiFetchChunkProgress(attemptId: string, conversationId: string | undefined, chunkBytes: number): void {
    if (!shouldLogTransient(`gemini:fetch-stream:chunk:${attemptId}`, 8000)) {
        return;
    }
    log('info', 'Gemini fetch stream progress', {
        attemptId,
        chunkBytes,
        conversationId: conversationId ?? null,
    });
}

function appendGeminiBufferChunk(buffer: string, chunkText: string): string {
    const maxBufferBytes = 900_000;
    const keepTailBytes = 700_000;
    const next = buffer + chunkText;
    if (next.length <= maxBufferBytes) {
        return next;
    }
    return next.slice(-keepTailBytes);
}

function syncGeminiSeenPayloadOrderFromSet(seenPayloadOrder: string[], seenPayloads: Set<string>): void {
    for (const payload of seenPayloads) {
        if (seenPayloadOrder.includes(payload)) {
            continue;
        }
        seenPayloadOrder.push(payload);
    }
    trimGeminiPayloadHistory(seenPayloadOrder, seenPayloads);
}

function resolveGeminiConversationFromFetchStream(
    attemptId: string,
    conversationId: string | undefined,
    parsedConversationId: string | undefined,
): string | undefined {
    if (conversationId || !parsedConversationId) {
        return conversationId;
    }
    emitConversationIdResolvedSignal(attemptId, parsedConversationId, 'Gemini');
    if (shouldLogTransient(`gemini:fetch-stream:resolved:${attemptId}`, 8000)) {
        log('info', 'Gemini conversation resolved from stream', {
            attemptId,
            conversationId: parsedConversationId,
        });
    }
    return parsedConversationId;
}

function emitGeminiStreamingLifecycleFromFetch(
    attemptId: string,
    conversationId: string | undefined,
    emittedStreaming: boolean,
    textCandidates: string[],
    chunkText: string,
): boolean {
    if (emittedStreaming || (textCandidates.length === 0 && chunkText.trim().length === 0)) {
        return emittedStreaming;
    }
    emitLifecycleSignal(attemptId, 'streaming', conversationId, 'Gemini');
    return true;
}

function emitGeminiFetchTextCandidates(
    attemptId: string,
    conversationId: string | undefined,
    textCandidates: string[],
    emittedText: Set<string>,
    emittedTextOrder: string[],
): void {
    for (const candidate of textCandidates) {
        if (emittedText.has(candidate)) {
            continue;
        }
        emittedText.add(candidate);
        emittedTextOrder.push(candidate);
        trimGeminiDeltaHistory(emittedTextOrder, emittedText);
        emitStreamDeltaSignal(attemptId, conversationId, candidate, 'Gemini');
        emitStreamDumpFrame(attemptId, conversationId, 'heuristic', candidate, candidate.length, 'Gemini');
        if (shouldLogTransient(`gemini:fetch-stream:candidate:${attemptId}`, 6000)) {
            log('info', 'Gemini stream candidate emitted', {
                attemptId,
                conversationId: conversationId ?? null,
                length: candidate.length,
                preview: candidate.slice(0, 120),
            });
        }
    }
}

function createGeminiXhrStreamState(attemptId: string, seedConversationId?: string): GeminiXhrStreamState {
    return {
        attemptId,
        seedConversationId,
        lastLength: 0,
        buffer: '',
        seenPayloads: new Set<string>(),
        seenPayloadOrder: [],
        emittedText: new Set<string>(),
        emittedTextOrder: [],
        emittedTitles: new Set<string>(),
        emittedStreaming: false,
    };
}

function syncGeminiSeenPayloadOrder(state: GeminiXhrStreamState): void {
    for (const payload of state.seenPayloads) {
        if (state.seenPayloadOrder.includes(payload)) {
            continue;
        }
        state.seenPayloadOrder.push(payload);
    }
    trimGeminiPayloadHistory(state.seenPayloadOrder, state.seenPayloads);
}

function emitGeminiTextCandidates(
    state: GeminiXhrStreamState,
    conversationId: string | undefined,
    candidates: string[],
): void {
    for (const candidate of candidates) {
        if (state.emittedText.has(candidate)) {
            continue;
        }
        state.emittedText.add(candidate);
        state.emittedTextOrder.push(candidate);
        trimGeminiDeltaHistory(state.emittedTextOrder, state.emittedText);
        emitStreamDeltaSignal(state.attemptId, conversationId, candidate, 'Gemini');
        emitStreamDumpFrame(state.attemptId, conversationId, 'heuristic', candidate, candidate.length, 'Gemini');
    }
}

function emitGeminiTitleCandidates(
    attemptId: string,
    conversationId: string | undefined,
    titleCandidates: string[],
    emittedTitles: Set<string>,
): void {
    if (!conversationId) {
        return;
    }
    for (const title of titleCandidates) {
        const normalized = title.trim();
        if (normalized.length === 0 || emittedTitles.has(normalized)) {
            continue;
        }
        emittedTitles.add(normalized);
        emitTitleResolvedSignal(attemptId, conversationId, normalized, 'Gemini');
        if (shouldLogTransient(`gemini:title:emitted:${attemptId}`, 6000)) {
            log('info', 'Gemini stream title emitted', {
                attemptId,
                conversationId,
                title: normalized,
            });
        }
    }
}

function processGeminiXhrProgressChunk(state: GeminiXhrStreamState, chunkText: string): void {
    if (chunkText.length === 0) {
        return;
    }
    if (isAttemptDisposed(state.attemptId)) {
        return;
    }
    if (shouldLogTransient(`gemini:xhr-stream:chunk:${state.attemptId}`, 8000)) {
        log('info', 'Gemini XHR stream progress', {
            attemptId: state.attemptId,
            chunkBytes: chunkText.length,
            conversationId: state.seedConversationId ?? null,
        });
    }

    state.buffer += chunkText;
    if (state.buffer.length > 900_000) {
        state.buffer = state.buffer.slice(-700_000);
    }

    emitStreamDumpFrame(state.attemptId, state.seedConversationId, 'delta', chunkText, chunkText.length, 'Gemini');

    const signals = extractGeminiStreamSignalsFromBuffer(state.buffer, state.seenPayloads);
    syncGeminiSeenPayloadOrder(state);

    const resolvedConversationId = signals.conversationId ?? state.seedConversationId;
    if (!state.seedConversationId && resolvedConversationId) {
        state.seedConversationId = resolvedConversationId;
        emitConversationIdResolvedSignal(state.attemptId, resolvedConversationId, 'Gemini');
        if (shouldLogTransient(`gemini:xhr-stream:resolved:${state.attemptId}`, 8000)) {
            log('info', 'Gemini XHR conversation resolved from stream', {
                attemptId: state.attemptId,
                conversationId: resolvedConversationId,
            });
        }
    }

    if (!state.emittedStreaming && (signals.textCandidates.length > 0 || chunkText.trim().length > 0)) {
        state.emittedStreaming = true;
        emitLifecycleSignal(state.attemptId, 'streaming', resolvedConversationId, 'Gemini');
    }

    emitGeminiTextCandidates(state, resolvedConversationId, signals.textCandidates);
    emitGeminiTitleCandidates(state.attemptId, resolvedConversationId, signals.titleCandidates, state.emittedTitles);
}

function wireGeminiXhrProgressMonitor(
    xhr: XMLHttpRequest,
    attemptId: string,
    seedConversationId: string | undefined,
): void {
    if (shouldLogTransient(`gemini:xhr-stream:start:${attemptId}`, 8000)) {
        log('info', 'Gemini XHR stream monitor start', {
            attemptId,
            conversationId: seedConversationId ?? null,
        });
    }
    const state = createGeminiXhrStreamState(attemptId, seedConversationId);

    const flushProgress = () => {
        if (typeof xhr.responseText !== 'string') {
            return;
        }
        if (xhr.responseText.length <= state.lastLength) {
            return;
        }
        const chunkText = xhr.responseText.slice(state.lastLength);
        state.lastLength = xhr.responseText.length;
        processGeminiXhrProgressChunk(state, chunkText);
    };

    const handleProgress = () => {
        flushProgress();
    };

    const handleLoadEnd = () => {
        flushProgress();
        // Gemini StreamGenerate completion can miss explicit completion hints in
        // some sessions. Emit completed lifecycle when the XHR finishes cleanly.
        if (
            !isAttemptDisposed(state.attemptId) &&
            xhr.readyState === XMLHttpRequest.DONE &&
            xhr.status >= 200 &&
            xhr.status < 300 &&
            (state.emittedStreaming || !!state.seedConversationId)
        ) {
            emitLifecycleSignal(state.attemptId, 'completed', state.seedConversationId, 'Gemini');
        }
        xhr.removeEventListener('progress', handleProgress);
        xhr.removeEventListener('loadend', handleLoadEnd);
    };

    xhr.addEventListener('progress', handleProgress);
    xhr.addEventListener('loadend', handleLoadEnd);
}

function trimGrokPayloadHistory(seenPayloadOrder: string[], seenPayloads: Set<string>): void {
    const maxEntries = 260;
    while (seenPayloadOrder.length > maxEntries) {
        const oldest = seenPayloadOrder.shift();
        if (oldest) {
            seenPayloads.delete(oldest);
        }
    }
}

function trimGrokSignalHistory(emittedSignalOrder: string[], emittedSignals: Set<string>): void {
    const maxEntries = 360;
    while (emittedSignalOrder.length > maxEntries) {
        const oldest = emittedSignalOrder.shift();
        if (oldest) {
            emittedSignals.delete(oldest);
        }
    }
}

function emitGrokStreamCandidates(
    attemptId: string,
    conversationId: string | undefined,
    textCandidates: string[],
    reasoningCandidates: string[],
    emittedSignals: Set<string>,
    emittedSignalOrder: string[],
): void {
    const emitCandidate = (candidate: string, kind: 'text' | 'thinking') => {
        const normalized = candidate.trim();
        if (normalized.length === 0) {
            return;
        }
        const signalKey = `${kind}:${normalized}`;
        if (emittedSignals.has(signalKey)) {
            return;
        }
        emittedSignals.add(signalKey);
        emittedSignalOrder.push(signalKey);
        trimGrokSignalHistory(emittedSignalOrder, emittedSignals);

        const text = kind === 'thinking' ? `[Thinking] ${normalized}` : normalized;
        emitStreamDeltaSignal(attemptId, conversationId, text, 'Grok');
        emitStreamDumpFrame(attemptId, conversationId, 'heuristic', text, text.length, 'Grok');
    };

    for (const candidate of textCandidates) {
        emitCandidate(candidate, 'text');
    }
    for (const candidate of reasoningCandidates) {
        emitCandidate(candidate, 'thinking');
    }
}

function appendGrokSeenPayloads(seenPayloadOrder: string[], seenPayloads: Set<string>, payloads: string[]): void {
    for (const payload of payloads) {
        seenPayloadOrder.push(payload);
    }
    trimGrokPayloadHistory(seenPayloadOrder, seenPayloads);
}

async function monitorGrokResponseStream(
    response: Response,
    attemptId: string,
    seedConversationId: string | undefined,
    requestUrl: string,
    emitLifecyclePhases: boolean,
): Promise<void> {
    if (!response.body || isAttemptDisposed(attemptId)) {
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let conversationId = seedConversationId;
    let emittedStreaming = false;
    const seenPayloads = new Set<string>();
    const seenPayloadOrder: string[] = [];
    const emittedSignals = new Set<string>();
    const emittedSignalOrder: string[] = [];

    if (conversationId) {
        emitConversationIdResolvedSignal(attemptId, conversationId, 'Grok');
    }

    if (shouldLogTransient(`grok:fetch-stream:start:${attemptId}`, 8000)) {
        log('info', 'Grok fetch stream monitor start', {
            attemptId,
            conversationId: conversationId ?? null,
            path: safePathname(requestUrl),
        });
    }

    try {
        await consumeReadableStreamChunks(reader, decoder, attemptId, (chunkText, chunkBytes) => {
            const result = processGrokFetchStreamChunk(
                attemptId,
                conversationId,
                emittedStreaming,
                buffer,
                chunkText,
                chunkBytes,
                emitLifecyclePhases,
                seenPayloads,
                seenPayloadOrder,
                emittedSignals,
                emittedSignalOrder,
            );
            conversationId = result.conversationId;
            emittedStreaming = result.emittedStreaming;
            buffer = result.buffer;
        });
    } catch {
        // Ignore stream monitor errors; canonical capture path remains authoritative.
    } finally {
        reader.releaseLock();
    }
}

function processGrokFetchStreamChunk(
    attemptId: string,
    conversationId: string | undefined,
    emittedStreaming: boolean,
    buffer: string,
    chunkText: string,
    chunkBytes: number,
    emitLifecyclePhases: boolean,
    seenPayloads: Set<string>,
    seenPayloadOrder: string[],
    emittedSignals: Set<string>,
    emittedSignalOrder: string[],
): { conversationId: string | undefined; emittedStreaming: boolean; buffer: string } {
    logGrokFetchChunkProgress(attemptId, conversationId, chunkBytes);
    emitStreamDumpFrame(attemptId, conversationId, 'delta', chunkText, chunkBytes, 'Grok');
    buffer = appendGrokBufferChunk(buffer, chunkText);

    const signals = extractGrokStreamSignalsFromBuffer(buffer, seenPayloads);
    buffer = signals.remainingBuffer;
    appendGrokSeenPayloads(seenPayloadOrder, seenPayloads, signals.seenPayloadKeys);

    conversationId = resolveGrokConversationFromFetchStream(attemptId, conversationId, signals.conversationId);
    emittedStreaming = emitGrokStreamingLifecycleFromFetch(
        attemptId,
        conversationId,
        emittedStreaming,
        emitLifecyclePhases,
        signals.textCandidates,
        signals.reasoningCandidates,
        chunkText,
    );

    emitGrokStreamCandidates(
        attemptId,
        conversationId,
        signals.textCandidates,
        signals.reasoningCandidates,
        emittedSignals,
        emittedSignalOrder,
    );

    logGrokFetchCandidateCounts(
        attemptId,
        conversationId,
        signals.textCandidates.length,
        signals.reasoningCandidates.length,
    );

    return { conversationId, emittedStreaming, buffer };
}

function logGrokFetchChunkProgress(attemptId: string, conversationId: string | undefined, chunkBytes: number): void {
    if (!shouldLogTransient(`grok:fetch-stream:chunk:${attemptId}`, 7000)) {
        return;
    }
    log('info', 'Grok fetch stream progress', {
        attemptId,
        chunkBytes,
        conversationId: conversationId ?? null,
    });
}

function appendGrokBufferChunk(buffer: string, chunkText: string): string {
    const maxBufferBytes = 1_000_000;
    const keepTailBytes = 800_000;
    const next = buffer + chunkText;
    if (next.length <= maxBufferBytes) {
        return next;
    }
    return next.slice(-keepTailBytes);
}

function resolveGrokConversationFromFetchStream(
    attemptId: string,
    conversationId: string | undefined,
    parsedConversationId: string | undefined,
): string | undefined {
    if (conversationId || !parsedConversationId) {
        return conversationId;
    }
    emitConversationIdResolvedSignal(attemptId, parsedConversationId, 'Grok');
    if (shouldLogTransient(`grok:fetch-stream:resolved:${attemptId}`, 7000)) {
        log('info', 'Grok conversation resolved from stream', {
            attemptId,
            conversationId: parsedConversationId,
        });
    }
    return parsedConversationId;
}

function emitGrokStreamingLifecycleFromFetch(
    attemptId: string,
    conversationId: string | undefined,
    emittedStreaming: boolean,
    emitLifecyclePhases: boolean,
    textCandidates: string[],
    reasoningCandidates: string[],
    chunkText: string,
): boolean {
    if (
        !emitLifecyclePhases ||
        emittedStreaming ||
        (textCandidates.length === 0 && reasoningCandidates.length === 0 && chunkText.trim().length === 0)
    ) {
        return emittedStreaming;
    }
    emitLifecycleSignal(attemptId, 'streaming', conversationId, 'Grok');
    return true;
}

function logGrokFetchCandidateCounts(
    attemptId: string,
    conversationId: string | undefined,
    textCount: number,
    reasoningCount: number,
): void {
    if (!shouldLogTransient(`grok:fetch-stream:signals:${attemptId}`, 7000)) {
        return;
    }
    if (textCount === 0 && reasoningCount === 0) {
        return;
    }
    log('info', 'Grok stream candidates emitted', {
        attemptId,
        conversationId: conversationId ?? null,
        textCandidates: textCount,
        reasoningCandidates: reasoningCount,
    });
}

function createGrokXhrStreamState(
    attemptId: string,
    requestUrl: string,
    seedConversationId?: string,
): GrokXhrStreamState {
    return {
        attemptId,
        requestUrl,
        seedConversationId,
        lastLength: 0,
        buffer: '',
        seenPayloads: new Set<string>(),
        seenPayloadOrder: [],
        emittedSignals: new Set<string>(),
        emittedSignalOrder: [],
        emittedStreaming: false,
    };
}

function processGrokXhrProgressChunk(state: GrokXhrStreamState, chunkText: string): void {
    if (chunkText.length === 0 || isAttemptDisposed(state.attemptId)) {
        return;
    }

    if (shouldLogTransient(`grok:xhr-stream:chunk:${state.attemptId}`, 7000)) {
        log('info', 'Grok XHR stream progress', {
            attemptId: state.attemptId,
            chunkBytes: chunkText.length,
            conversationId: state.seedConversationId ?? null,
        });
    }

    emitStreamDumpFrame(state.attemptId, state.seedConversationId, 'delta', chunkText, chunkText.length, 'Grok');
    state.buffer += chunkText;
    if (state.buffer.length > 1_000_000) {
        state.buffer = state.buffer.slice(-800_000);
    }

    const signals = extractGrokStreamSignalsFromBuffer(state.buffer, state.seenPayloads);
    state.buffer = signals.remainingBuffer;
    appendGrokSeenPayloads(state.seenPayloadOrder, state.seenPayloads, signals.seenPayloadKeys);

    const resolvedConversationId = signals.conversationId ?? state.seedConversationId;
    if (!state.seedConversationId && resolvedConversationId) {
        state.seedConversationId = resolvedConversationId;
        emitConversationIdResolvedSignal(state.attemptId, resolvedConversationId, 'Grok');
        if (shouldLogTransient(`grok:xhr-stream:resolved:${state.attemptId}`, 7000)) {
            log('info', 'Grok XHR conversation resolved from stream', {
                attemptId: state.attemptId,
                conversationId: resolvedConversationId,
            });
        }
    }

    if (
        !state.emittedStreaming &&
        (signals.textCandidates.length > 0 || signals.reasoningCandidates.length > 0 || chunkText.trim().length > 0)
    ) {
        state.emittedStreaming = true;
        emitLifecycleSignal(state.attemptId, 'streaming', resolvedConversationId, 'Grok');
    }

    emitGrokStreamCandidates(
        state.attemptId,
        resolvedConversationId,
        signals.textCandidates,
        signals.reasoningCandidates,
        state.emittedSignals,
        state.emittedSignalOrder,
    );
}

function wireGrokXhrProgressMonitor(
    xhr: XMLHttpRequest,
    attemptId: string,
    seedConversationId: string | undefined,
): void {
    if (shouldLogTransient(`grok:xhr-stream:start:${attemptId}`, 7000)) {
        log('info', 'Grok XHR stream monitor start', {
            attemptId,
            conversationId: seedConversationId ?? null,
        });
    }
    const state = createGrokXhrStreamState(
        attemptId,
        ((xhr as any)._url as string | undefined) ?? '',
        seedConversationId,
    );

    const flushProgress = () => {
        if (typeof xhr.responseText !== 'string') {
            return;
        }
        if (xhr.responseText.length <= state.lastLength) {
            return;
        }
        const chunkText = xhr.responseText.slice(state.lastLength);
        state.lastLength = xhr.responseText.length;
        processGrokXhrProgressChunk(state, chunkText);
    };

    const handleProgress = () => {
        flushProgress();
    };

    const handleLoadEnd = () => {
        flushProgress();
        if (shouldLogTransient(`grok:xhr-stream:end:${state.attemptId}`, 7000)) {
            log('info', 'Grok XHR stream monitor complete', {
                attemptId: state.attemptId,
                conversationId: state.seedConversationId ?? null,
                path: safePathname(state.requestUrl),
            });
        }
        xhr.removeEventListener('progress', handleProgress);
        xhr.removeEventListener('loadend', handleLoadEnd);
    };

    xhr.addEventListener('progress', handleProgress);
    xhr.addEventListener('loadend', handleLoadEnd);
}

function parseConversationData(adapter: LLMPlatform, payload: string, url: string): ConversationData | null {
    try {
        return adapter.parseInterceptedData(payload, url);
    } catch {
        return null;
    }
}

function resolveParsedConversationId(
    adapter: LLMPlatform,
    parsed: ConversationData | null,
    url: string,
): string | undefined {
    return (
        parsed?.conversation_id ?? adapter.extractConversationIdFromUrl?.(url) ?? extractConversationIdFromAnyUrl(url)
    );
}

function extractLatestAssistantText(parsed: ConversationData): string | null {
    const messages = Object.values(parsed.mapping)
        .map((node) => node.message)
        .filter(
            (message): message is NonNullable<(typeof parsed.mapping)[string]['message']> =>
                !!message && message.author.role === 'assistant',
        )
        .sort((left, right) => {
            const leftTs = left.update_time ?? left.create_time ?? 0;
            const rightTs = right.update_time ?? right.create_time ?? 0;
            return leftTs - rightTs;
        });

    if (messages.length === 0) {
        return null;
    }

    const latest = messages[messages.length - 1];
    const text = (latest.content.parts ?? []).filter((part): part is string => typeof part === 'string').join('');
    const normalized = text.trim();
    if (normalized.length === 0 || /^v\d+$/i.test(normalized)) {
        return null;
    }
    return normalized;
}

function emitNonChatGptStreamSnapshot(
    adapter: LLMPlatform,
    attemptId: string,
    conversationId: string | undefined,
    parsed: ConversationData | null,
): void {
    if (!parsed || adapter.name === 'ChatGPT') {
        return;
    }
    const text = extractLatestAssistantText(parsed);
    if (!text) {
        return;
    }
    emitStreamDeltaSignal(attemptId, conversationId, text, adapter.name);
    emitStreamDumpFrame(attemptId, conversationId, 'snapshot', text, text.length, adapter.name);
}

async function monitorChatGptSseLifecycle(
    response: Response,
    attemptId: string,
    conversationId?: string,
): Promise<void> {
    if (!response.body) {
        return;
    }

    const reader = response.body.getReader();
    let lifecycleConversationId = conversationId;
    let sawContent = false;
    let doneSignalSeen = false;
    let streamBuffer = '';
    let sseBufferForAdapter = '';
    let lastDelta = '';
    let sampledFrames = 0;
    const sampledFrameLimit = 3;
    const decoder = new TextDecoder();
    if (lifecycleConversationId) {
        emitConversationIdResolvedSignal(attemptId, lifecycleConversationId);
    }

    try {
        await consumeReadableStreamChunks(reader, decoder, attemptId, (chunkText) => {
            lifecycleConversationId = resolveChatGptConversationIdFromChunk(
                attemptId,
                lifecycleConversationId,
                chunkText,
            );
            sawContent = emitChatGptStreamingLifecycle(attemptId, lifecycleConversationId, sawContent, chunkText);
            streamBuffer += chunkText;

            const frames = extractChatGptSseFramesFromBuffer(streamBuffer);
            streamBuffer = frames.remainingBuffer;
            for (const frame of frames.frames) {
                const dataPayload = extractChatGptSseDataPayload(frame);
                if (!dataPayload) {
                    continue;
                }

                const frameResult = processChatGptSseDataPayload({
                    attemptId,
                    dataPayload,
                    conversationId: lifecycleConversationId,
                    sseBufferForAdapter,
                    lastDelta,
                    sampledFrames,
                    sampledFrameLimit,
                });

                doneSignalSeen = doneSignalSeen || frameResult.doneSignalSeen;
                sseBufferForAdapter = frameResult.sseBufferForAdapter;
                lastDelta = frameResult.lastDelta;
                sampledFrames = frameResult.sampledFrames;
            }
        });
    } catch {
        // Ignore stream read errors; fallback completion signals will handle final state.
    } finally {
        if (!doneSignalSeen && streamBuffer.includes('data: [DONE]')) {
            emitLifecycleSignal(attemptId, 'completed', lifecycleConversationId);
        }
        reader.releaseLock();
    }
}

function resolveChatGptConversationIdFromChunk(
    attemptId: string,
    conversationId: string | undefined,
    chunkText: string,
): string | undefined {
    if (conversationId) {
        return conversationId;
    }
    const idMatch = chunkText.match(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/i);
    if (!idMatch?.[0]) {
        return conversationId;
    }
    emitConversationIdResolvedSignal(attemptId, idMatch[0]);
    return idMatch[0];
}

function emitChatGptStreamingLifecycle(
    attemptId: string,
    conversationId: string | undefined,
    sawContent: boolean,
    chunkText: string,
): boolean {
    if (sawContent || chunkText.trim().length === 0) {
        return sawContent;
    }
    emitLifecycleSignal(attemptId, 'streaming', conversationId);
    return true;
}

function extractChatGptSseFramesFromBuffer(buffer: string): { frames: string[]; remainingBuffer: string } {
    const frames: string[] = [];
    let remainingBuffer = buffer;
    let delimiterIndex = remainingBuffer.indexOf('\n\n');
    while (delimiterIndex >= 0) {
        frames.push(remainingBuffer.slice(0, delimiterIndex));
        remainingBuffer = remainingBuffer.slice(delimiterIndex + 2);
        delimiterIndex = remainingBuffer.indexOf('\n\n');
    }
    return { frames, remainingBuffer };
}

function extractChatGptSseDataPayload(frame: string): string {
    return frame
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
        .trim();
}

type ChatGptSsePayloadContext = {
    attemptId: string;
    dataPayload: string;
    conversationId: string | undefined;
    sseBufferForAdapter: string;
    lastDelta: string;
    sampledFrames: number;
    sampledFrameLimit: number;
};

type ChatGptSsePayloadResult = {
    doneSignalSeen: boolean;
    sseBufferForAdapter: string;
    lastDelta: string;
    sampledFrames: number;
};

function processChatGptSseDataPayload(context: ChatGptSsePayloadContext): ChatGptSsePayloadResult {
    const { attemptId, dataPayload, conversationId } = context;
    let { sseBufferForAdapter, lastDelta, sampledFrames } = context;

    if (dataPayload === '[DONE]') {
        emitLifecycleSignal(attemptId, 'completed', conversationId);
        return {
            doneSignalSeen: true,
            sseBufferForAdapter,
            lastDelta,
            sampledFrames,
        };
    }

    emitChatGptTitleFromPayload(attemptId, conversationId, dataPayload);
    sseBufferForAdapter = appendChatGptSseAdapterBuffer(sseBufferForAdapter, dataPayload);

    const emission = emitChatGptDeltaFromPayload(
        attemptId,
        conversationId,
        dataPayload,
        sseBufferForAdapter,
        lastDelta,
    );
    lastDelta = emission.lastDelta;
    if (!emission.hadSnapshot) {
        sampledFrames = logChatGptStreamFrameSample(
            conversationId,
            dataPayload,
            sampledFrames,
            context.sampledFrameLimit,
        );
    }

    return {
        doneSignalSeen: false,
        sseBufferForAdapter,
        lastDelta,
        sampledFrames,
    };
}

function emitChatGptTitleFromPayload(attemptId: string, conversationId: string | undefined, dataPayload: string): void {
    const resolvedTitle = extractTitleFromSsePayload(dataPayload);
    if (!resolvedTitle || !conversationId) {
        return;
    }
    emitTitleResolvedSignal(attemptId, conversationId, resolvedTitle);
}

function appendChatGptSseAdapterBuffer(sseBufferForAdapter: string, dataPayload: string): string {
    const maxBufferBytes = 400_000;
    const keepTailBytes = 250_000;
    const next = `${sseBufferForAdapter}data: ${dataPayload}\n\n`;
    if (next.length <= maxBufferBytes) {
        return next;
    }
    return next.slice(-keepTailBytes);
}

function emitChatGptDeltaFromPayload(
    attemptId: string,
    conversationId: string | undefined,
    dataPayload: string,
    sseBufferForAdapter: string,
    lastDelta: string,
): { hadSnapshot: boolean; lastDelta: string } {
    const snapshot = extractAssistantTextSnapshotFromSseBuffer(sseBufferForAdapter);
    if (snapshot && snapshot !== lastDelta) {
        emitStreamDeltaSignal(attemptId, conversationId, snapshot);
        emitStreamDumpFrame(attemptId, conversationId, 'snapshot', snapshot, dataPayload.length);
        return { hadSnapshot: true, lastDelta: snapshot };
    }
    if (snapshot) {
        return { hadSnapshot: true, lastDelta };
    }

    for (const candidate of extractLikelyTextFromSsePayload(dataPayload)) {
        if (candidate === lastDelta) {
            continue;
        }
        lastDelta = candidate;
        emitStreamDeltaSignal(attemptId, conversationId, candidate);
        emitStreamDumpFrame(attemptId, conversationId, 'heuristic', candidate, dataPayload.length);
    }
    return { hadSnapshot: false, lastDelta };
}

function logChatGptStreamFrameSample(
    conversationId: string | undefined,
    dataPayload: string,
    sampledFrames: number,
    sampledFrameLimit: number,
): number {
    if (sampledFrames >= sampledFrameLimit) {
        return sampledFrames;
    }
    log('info', 'stream frame sample', {
        conversationId: conversationId ?? null,
        bytes: dataPayload.length,
        preview: dataPayload.slice(0, 220),
    });
    return sampledFrames + 1;
}

function isConversationLike(candidate: any, conversationId: string): boolean {
    if (!candidate || typeof candidate !== 'object') {
        return false;
    }
    const hasCoreShape =
        typeof candidate.title === 'string' && !!candidate.mapping && typeof candidate.mapping === 'object';
    if (!hasCoreShape) {
        return false;
    }
    if (typeof candidate.conversation_id === 'string' && candidate.conversation_id === conversationId) {
        return true;
    }
    if (typeof candidate.id === 'string' && candidate.id === conversationId) {
        return true;
    }
    return false;
}

function toObjectRecord(item: unknown): Record<string, unknown> | null {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
    }
    return item as Record<string, unknown>;
}

function enqueueChildren(queue: unknown[], item: unknown): void {
    if (!item || typeof item !== 'object') {
        return;
    }
    if (Array.isArray(item)) {
        for (const child of item) {
            queue.push(child);
        }
        return;
    }
    const obj = item as Record<string, unknown>;
    for (const value of Object.values(obj)) {
        queue.push(value);
    }
}

function pickConversationCandidate(item: unknown, conversationId: string): unknown | null {
    if (isConversationLike(item, conversationId)) {
        return item;
    }
    const obj = toObjectRecord(item);
    if (!obj) {
        return null;
    }
    if (isConversationLike(obj.conversation, conversationId)) {
        return obj.conversation;
    }
    if (isConversationLike(obj.data, conversationId)) {
        return obj.data;
    }
    return null;
}

function findConversationCandidate(root: unknown, conversationId: string): unknown | null {
    const queue: unknown[] = [root];
    const seen = new Set<unknown>();
    let scanned = 0;
    const maxNodes = 6000;

    while (queue.length > 0 && scanned < maxNodes) {
        const item = queue.shift();
        scanned += 1;
        if (!item || typeof item !== 'object') {
            continue;
        }
        if (seen.has(item)) {
            continue;
        }
        seen.add(item);

        const candidate = pickConversationCandidate(item, conversationId);
        if (candidate) {
            return candidate;
        }
        enqueueChildren(queue, item);
    }

    return null;
}

function extractTurnText(turn: Element): string {
    const contentElement =
        turn.querySelector(
            '.whitespace-pre-wrap, .markdown, [data-message-content], [data-testid="conversation-turn-content"]',
        ) ?? turn.querySelector('[data-message-author-role]');
    return (contentElement?.textContent ?? '').trim();
}

function extractThoughtFragments(turn: Element): string[] {
    const selectors = [
        '[data-testid*="thought"]',
        '[data-message-content-type="thought"]',
        '[data-content-type="thought"]',
        'details summary',
    ];
    const fragments: string[] = [];
    for (const selector of selectors) {
        const nodes = turn.querySelectorAll(selector);
        for (const node of nodes) {
            const text = (node.textContent ?? '').trim();
            if (text.length > 0) {
                fragments.push(text);
            }
        }
    }
    return [...new Set(fragments)];
}

function normalizeDomTitle(rawTitle: string): string {
    return rawTitle.replace(/\s*[-|]\s*ChatGPT.*$/i, '').trim();
}

function extractTurnRole(turn: Element): 'system' | 'user' | 'assistant' | 'tool' | null {
    const messageDiv = turn.querySelector('[data-message-author-role]');
    const role = messageDiv?.getAttribute('data-message-author-role');
    if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') {
        return role;
    }
    return null;
}

function buildDomMessageContent(text: string, thoughtFragments: string[]): Record<string, unknown> {
    if (thoughtFragments.length > 0 && text.length === 0) {
        return {
            content_type: 'thoughts',
            thoughts: thoughtFragments.map((summary) => ({
                summary,
                content: summary,
                chunks: [],
                finished: true,
            })),
        };
    }

    return {
        content_type: 'text',
        parts: text ? [text] : [],
    };
}

function appendDomSnapshotMessage(
    mapping: Record<string, any>,
    parentId: string,
    role: 'system' | 'user' | 'assistant' | 'tool',
    messageId: string,
    content: Record<string, unknown>,
    now: number,
    index: number,
    thoughtFragments: string[],
): string {
    const metadata = thoughtFragments.length > 0 ? { reasoning: thoughtFragments.join('\n\n') } : {};
    mapping[messageId] = {
        id: messageId,
        message: {
            id: messageId,
            author: {
                role,
                name: null,
                metadata: {},
            },
            create_time: now + index,
            update_time: now + index,
            content,
            status: 'finished_successfully',
            end_turn: true,
            weight: 1,
            metadata,
            recipient: 'all',
            channel: null,
        },
        parent: parentId,
        children: [],
    };
    mapping[parentId].children.push(messageId);
    return messageId;
}

function buildDomConversationSnapshot(conversationId: string): unknown | null {
    const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
    if (turns.length === 0) {
        return null;
    }

    const mapping: Record<string, any> = {
        root: {
            id: 'root',
            message: null,
            parent: null,
            children: [],
        },
    };

    const now = Math.floor(Date.now() / 1000);
    let parentId = 'root';
    let index = 0;

    for (const turn of turns) {
        const role = extractTurnRole(turn);
        if (!role) {
            continue;
        }

        const text = extractTurnText(turn);
        const thoughtFragments = extractThoughtFragments(turn);
        if (!text && thoughtFragments.length === 0) {
            continue;
        }

        index += 1;
        const messageId = `dom-${conversationId}-${index}`;
        const content = buildDomMessageContent(text, thoughtFragments);
        parentId = appendDomSnapshotMessage(mapping, parentId, role, messageId, content, now, index, thoughtFragments);
    }

    if (parentId === 'root') {
        return null;
    }

    return {
        title: normalizeDomTitle(document.title || ''),
        create_time: now,
        update_time: now + index,
        mapping,
        conversation_id: conversationId,
        current_node: parentId,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: 'unknown',
        safe_urls: [],
        blocked_urls: [],
    };
}

function getPageConversationSnapshot(conversationId: string): unknown | null {
    const roots: unknown[] = [
        (window as any).__NEXT_DATA__,
        (window as any).__remixContext,
        (window as any).__INITIAL_STATE__,
        (window as any).__APOLLO_STATE__,
        window,
    ];

    for (const root of roots) {
        const candidate = findConversationCandidate(root, conversationId);
        if (candidate) {
            return candidate;
        }
    }

    const domSnapshot = buildDomConversationSnapshot(conversationId);
    if (domSnapshot) {
        return domSnapshot;
    }

    return buildRawCaptureSnapshot(conversationId);
}

function isSnapshotRequestEvent(event: MessageEvent): PageSnapshotRequest | null {
    if (event.source !== window || event.origin !== window.location.origin) {
        return null;
    }
    const message = event.data as PageSnapshotRequest;
    if (message?.type !== 'BLACKIYA_PAGE_SNAPSHOT_REQUEST' || typeof message.requestId !== 'string') {
        return null;
    }
    return message;
}

function buildSnapshotResponse(requestId: string, snapshot: unknown | null): PageSnapshotResponse {
    if (snapshot) {
        return {
            type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE',
            requestId,
            success: true,
            data: snapshot,
        };
    }
    return {
        type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE',
        requestId,
        success: false,
        error: 'NOT_FOUND',
    };
}

function isDiscoveryModeHost(hostname: string): boolean {
    return hostname.includes('gemini.google.com') || hostname.includes('x.com') || hostname.includes('grok.com');
}

function isStaticAssetPath(path: string): boolean {
    return !!path.match(/\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico)$/i);
}

function getRequestUrl(request: Parameters<typeof fetch>[0]): string {
    return request instanceof Request ? request.url : String(request);
}

function getRequestMethod(args: Parameters<typeof fetch>): string {
    return args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET');
}

function emitCapturePayload(url: string, data: string, platform: string, attemptId?: string): void {
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
    queueInterceptedMessage(payload);
    window.postMessage(payload, window.location.origin);
}

function handleApiMatchFromFetch(
    url: string,
    adapter: LLMPlatform,
    response: Response,
    deferredCompletionAdapter?: LLMPlatform,
): void {
    const adapterName = adapter.name;
    const path = safePathname(url);
    if (shouldLogTransient(`api:match:${adapterName}:${path}`, 2500)) {
        log('info', `API match ${adapterName}`);
    }
    const clonedResponse = response.clone();
    clonedResponse
        .text()
        .then((text) => {
            const shouldCapturePayload = shouldEmitCapturedPayload(adapterName, url, text);
            if (shouldCapturePayload) {
                log('info', `API ${text.length}b ${adapterName}`);
            }
            const parsed = parseConversationData(adapter, text, url);
            const conversationId = resolveParsedConversationId(adapter, parsed, url);
            const attemptId = resolveAttemptIdForConversation(conversationId, adapterName);
            if (shouldCapturePayload) {
                emitApiResponseDumpFrame(adapterName, url, text, attemptId, conversationId);
                emitCapturePayload(url, text, adapterName, attemptId);
                emitNonChatGptStreamSnapshot(adapter, attemptId, conversationId, parsed);
            }
            // Emit completion signal AFTER the body is fully read and data is captured.
            // This ensures SFE transitions only after data is available in the cache,
            // preventing premature completed_hint → stabilization retry flickering.
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
            // Emit deferred completion even on error so the SFE isn't stuck
            if (deferredCompletionAdapter && !shouldSuppressCompletionSignal(deferredCompletionAdapter, url)) {
                emitResponseFinishedSignal(deferredCompletionAdapter, url);
            }
            const path = safePathname(url);
            if (adapterName === 'ChatGPT' && path.startsWith('/backend-api/f/conversation')) {
                return;
            }
            log('warn', `API read err ${adapterName}`, { path });
        });
}

function tryParseAndEmitConversation(adapter: LLMPlatform, url: string, text: string, source: string): boolean {
    const parsed = parseConversationData(adapter, text, url);
    if (parsed?.conversation_id) {
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
    }
    return false;
}

function inspectAuxConversationFetch(url: string, response: Response, adapter: LLMPlatform): void {
    const clonedResponse = response.clone();
    clonedResponse
        .text()
        .then((text) => {
            log('info', 'aux response', {
                path: safePathname(url),
                status: response.status,
                size: text.length,
            });
            if (!response.ok || text.length === 0) {
                return;
            }
            // Emit stream dump for aux responses (helps debug Grok NDJSON, Gemini side-fetches)
            if (streamDumpEnabled && text.length > 100) {
                const conversationId = extractConversationIdFromAnyUrl(url);
                const attemptId = resolveAttemptIdForConversation(conversationId, adapter.name);
                emitApiResponseDumpFrame(adapter.name, url, text, attemptId, conversationId);
            }
            const captured = tryParseAndEmitConversation(adapter, url, text, 'aux');
            if (!captured) {
                const path = safePathname(url);
                if (shouldLogTransient(`aux:miss:${path}`, 2500)) {
                    log('info', 'aux parse miss', { path });
                }
            }
        })
        .catch(() => {
            log('info', 'aux read err', { path: safePathname(url) });
        });
}

function logDiscoveryFetch(url: string, response: Response): void {
    if (!isDiscoveryDiagnosticsEnabled()) {
        return;
    }
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    if (isStaticAssetPath(path)) {
        return;
    }

    const search = urlObj.search;
    log('info', '[DISCOVERY] POST', {
        path,
        search: search.slice(0, 150),
        status: response.status,
        contentType: response.headers.get('content-type'),
    });

    const clonedResponse = response.clone();
    clonedResponse
        .text()
        .then((text) => {
            if (text.length > 500) {
                log('info', '[DISCOVERY] Response', {
                    path,
                    size: text.length,
                    preview: text.slice(0, 300),
                });
            }
            emitDiscoveryDumpFrame('DISCOVERY', path, text);
        })
        .catch(() => {
            // Ignore read errors in discovery mode
        });
}

function handleFetchInterception(args: Parameters<typeof fetch>, response: Response): void {
    const url = getRequestUrl(args[0]);
    const apiAdapter = getPlatformAdapterByApiUrl(url);
    const completionAdapter = getPlatformAdapterByCompletionUrl(url);

    if (apiAdapter) {
        // When a URL matches BOTH apiEndpointPattern and completionTriggerPattern,
        // defer the completion signal until after .text() resolves. This prevents
        // SFE from transitioning to completed_hint before data is available in cache,
        // which caused button flickering on Grok (conversations/new) and similar streaming fetch responses.
        handleApiMatchFromFetch(url, apiAdapter, response, completionAdapter ?? undefined);
        return;
    }

    if (completionAdapter) {
        // Completion-only URLs (e.g., ChatGPT stream_status) — fire immediately
        // because these are small non-streaming responses.
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

    const method = getRequestMethod(args);
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
        !apiAdapter &&
        !completionAdapter &&
        shouldLogTransient(`gemini:adapter-miss:fetch:${safePathname(url)}`, 8000)
    ) {
        log('warn', 'Gemini endpoint unmatched by adapter', {
            path: safePathname(url),
        });
    }
}

function logDiscoveryXhr(url: string, responseText: string): void {
    if (!isDiscoveryDiagnosticsEnabled()) {
        return;
    }
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    if (isStaticAssetPath(path) || responseText.length <= 500) {
        return;
    }
    log('info', '[DISCOVERY] XHR', {
        path,
        search: urlObj.search.slice(0, 150),
        size: responseText.length,
        preview: responseText.slice(0, 300),
    });
    emitDiscoveryDumpFrame('XHR DISCOVERY', path, responseText);
}

function handleXhrLoad(xhr: XMLHttpRequest, method: string): void {
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
        } catch {
            // Ignore errors in discovery mode
        }
    }

    if (
        window.location.hostname.includes('gemini.google.com') &&
        safePathname(url).includes('/_/BardChatUi/data/') &&
        !adapter &&
        !completionAdapter &&
        shouldLogTransient(`gemini:adapter-miss:xhr:${safePathname(url)}`, 8000)
    ) {
        log('warn', 'Gemini endpoint unmatched by adapter', {
            path: safePathname(url),
            method,
            status: xhr.status,
        });
    }
}

function processXhrApiMatch(url: string, xhr: XMLHttpRequest, adapter: LLMPlatform | null): boolean {
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
}

function processXhrAuxConversation(url: string, xhr: XMLHttpRequest, adapter: LLMPlatform | null): void {
    if (!adapter) {
        return;
    }

    log('info', 'aux response', {
        path: safePathname(url),
        status: xhr.status,
        size: xhr.responseText?.length ?? 0,
    });

    if (xhr.status < 200 || xhr.status >= 300 || !xhr.responseText) {
        return;
    }

    const captured = tryParseAndEmitConversation(adapter, url, xhr.responseText, 'aux');
    if (!captured) {
        const path = safePathname(url);
        if (shouldLogTransient(`aux:miss:${path}`, 2500)) {
            log('info', 'aux parse miss', { path });
        }
    }
}

function isFetchReady(adapter: LLMPlatform): boolean {
    return !!adapter.extractConversationIdFromUrl && (!!adapter.buildApiUrl || !!adapter.buildApiUrls);
}

function getApiUrlCandidates(adapter: LLMPlatform, conversationId: string): string[] {
    const urls: string[] = [];
    const multi = adapter.buildApiUrls?.(conversationId) ?? [];
    for (const url of multi) {
        if (typeof url === 'string' && url.length > 0 && !urls.includes(url)) {
            urls.push(url);
        }
    }

    const primary = adapter.buildApiUrl?.(conversationId);
    if (primary && !urls.includes(primary)) {
        urls.unshift(primary);
    }

    const currentOrigin = window.location.origin;
    const filtered = urls.filter((url) => {
        try {
            return new URL(url, currentOrigin).origin === currentOrigin;
        } catch {
            return false;
        }
    });

    return filtered.length > 0 ? filtered : [];
}

function isCapturedConversationReady(adapter: LLMPlatform, parsed: unknown): boolean {
    if (!parsed || typeof parsed !== 'object' || !('conversation_id' in parsed)) {
        return false;
    }
    const conversation = parsed as Parameters<NonNullable<LLMPlatform['evaluateReadiness']>>[0];
    if (adapter.evaluateReadiness) {
        return adapter.evaluateReadiness(conversation).ready;
    }
    return isConversationReady(conversation);
}

function shouldEmitCompletionSignalForParsedData(
    adapter: LLMPlatform,
    url: string,
    parsed: ConversationData | null,
): boolean {
    if (!shouldEmitCompletionSignalForUrl(adapter, url)) {
        return false;
    }
    if (adapter.name === 'Grok') {
        return isCapturedConversationReady(adapter, parsed);
    }
    return true;
}

export default defineContentScript({
    matches: [...SUPPORTED_PLATFORM_URLS],
    world: 'MAIN',
    runAt: 'document_start',
    main() {
        // Idempotency: prevent double-injection if the extension is reloaded or content script runs twice
        if ((window as any).__BLACKIYA_INTERCEPTED__) {
            log('info', 'already init (skip duplicate interceptor bootstrap)');
            return;
        }
        (window as any).__BLACKIYA_INTERCEPTED__ = true;

        // Store originals for cleanup/restore
        if (!(window as any).__BLACKIYA_ORIGINALS__) {
            (window as any).__BLACKIYA_ORIGINALS__ = {
                fetch: window.fetch,
                XMLHttpRequestOpen: XMLHttpRequest.prototype.open,
                XMLHttpRequestSend: XMLHttpRequest.prototype.send,
                XMLHttpRequestSetRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
            };
        }

        const originalFetch = window.fetch;
        const inFlightFetches = new Map<string, Promise<boolean>>();
        const proactiveSuccessAtByKey = new Map<string, number>();
        const proactiveHeadersByKey = new Map<string, HeaderRecord>();
        const proactiveSuccessCooldownMs = 20_000;
        // ChatGPT can materialize the full conversation payload late; keep retries bounded but longer.
        const proactiveBackoffMs = [900, 1800, 3200, 5000, 7000, 9000, 12000, 15000];

        const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

        const logFetchStatusFailure = (
            conversationId: string,
            apiUrl: string,
            status: number,
            attempt: number,
        ): void => {
            const path = safePathname(apiUrl);
            if (!shouldLogTransient(`fetch:status:${conversationId}:${path}:${status}`, 5000)) {
                return;
            }
            log('info', 'fetch response', {
                conversationId,
                ok: false,
                status,
                attempt,
            });
        };

        const emitFetchedConversationPayload = (
            adapter: LLMPlatform,
            apiUrl: string,
            conversationId: string,
            text: string,
            parsed: ConversationData,
            attemptId: string,
        ): void => {
            const payload = JSON.stringify(parsed);
            if (!shouldEmitCapturedPayload(adapter.name, apiUrl, payload, 3000)) {
                return;
            }
            log('info', `fetched ${conversationId} ${text.length}b`, {
                path: safePathname(apiUrl),
            });
            emitCapturePayload(apiUrl, payload, adapter.name, attemptId);
        };

        const parseFetchedConversation = (
            adapter: LLMPlatform,
            text: string,
            apiUrl: string,
        ): ConversationData | null => {
            const parsed = adapter.parseInterceptedData(text, apiUrl);
            if (!isCapturedConversationReady(adapter, parsed)) {
                return null;
            }
            return parsed;
        };

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
                const response = await originalFetch(apiUrl, {
                    credentials: 'include',
                    headers: requestHeaders,
                });

                if (!response.ok) {
                    logFetchStatusFailure(conversationId, apiUrl, response.status, attempt);
                    return false;
                }

                const text = await response.text();
                const parsed = parseFetchedConversation(adapter, text, apiUrl);
                if (!parsed) {
                    return false;
                }
                emitFetchedConversationPayload(adapter, apiUrl, conversationId, text, parsed, attemptId);
                return true;
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
                        proactiveSuccessAtByKey.set(key, Date.now());
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
            const lastSuccessAt = proactiveSuccessAtByKey.get(key) ?? 0;
            if (Date.now() - lastSuccessAt < proactiveSuccessCooldownMs) {
                return;
            }
            const mergedHeaders = mergeHeaderRecords(proactiveHeadersByKey.get(key), requestHeaders);
            if (mergedHeaders) {
                proactiveHeadersByKey.set(key, mergedHeaders);
            }

            if (inFlightFetches.has(key)) {
                return;
            }

            log('info', `trigger ${adapter.name} ${conversationId}`);

            const attemptId = resolveAttemptIdForConversation(conversationId, adapter.name);
            const run = runProactiveFetch(adapter, conversationId, key, attemptId);

            inFlightFetches.set(key, run);
            run.finally(() => {
                inFlightFetches.delete(key);
                proactiveHeadersByKey.delete(key);
            });
        };

        type FetchInterceptorContext = {
            args: Parameters<typeof fetch>;
            outgoingUrl: string;
            outgoingMethod: string;
            outgoingPath: string;
            fetchApiAdapter: LLMPlatform | null;
            isNonChatGptApiRequest: boolean;
            shouldEmitNonChatLifecycle: boolean;
            nonChatConversationId: string | undefined;
            nonChatAttemptId: string | undefined;
            isChatGptPromptRequest: boolean;
            lifecycleConversationId: string | undefined;
            lifecycleAttemptId: string | undefined;
        };

        const createFetchInterceptorContext = (args: Parameters<typeof fetch>): FetchInterceptorContext => {
            const outgoingUrl = getRequestUrl(args[0]);
            const outgoingMethod = getRequestMethod(args).toUpperCase();
            const outgoingPath = safePathname(outgoingUrl);
            const fetchApiAdapter = outgoingMethod === 'POST' ? getPlatformAdapterByApiUrl(outgoingUrl) : null;
            const isNonChatGptApiRequest = !!fetchApiAdapter && fetchApiAdapter.name !== chatGPTAdapter.name;
            const shouldEmitNonChatLifecycle =
                isNonChatGptApiRequest && shouldEmitNonChatLifecycleForRequest(fetchApiAdapter, outgoingUrl);
            const nonChatConversationId = isNonChatGptApiRequest
                ? resolveRequestConversationId(fetchApiAdapter, outgoingUrl)
                : undefined;
            const nonChatAttemptId =
                isNonChatGptApiRequest && fetchApiAdapter
                    ? resolveAttemptIdForConversation(nonChatConversationId, fetchApiAdapter.name)
                    : undefined;
            const isChatGptPromptRequest =
                outgoingMethod === 'POST' && /\/backend-api\/f\/conversation(?:\?.*)?$/i.test(outgoingPath);
            const lifecycleConversationId = isChatGptPromptRequest ? resolveLifecycleConversationId(args) : undefined;
            const lifecycleAttemptId = isChatGptPromptRequest ? createAttemptId('chatgpt') : undefined;
            return {
                args,
                outgoingUrl,
                outgoingMethod,
                outgoingPath,
                fetchApiAdapter,
                isNonChatGptApiRequest,
                shouldEmitNonChatLifecycle,
                nonChatConversationId,
                nonChatAttemptId,
                isChatGptPromptRequest,
                lifecycleConversationId,
                lifecycleAttemptId,
            };
        };

        const emitFetchPromptLifecycle = (context: FetchInterceptorContext): void => {
            if (context.isChatGptPromptRequest && context.lifecycleAttemptId) {
                latestAttemptIdByPlatform.set(chatGPTAdapter.name, context.lifecycleAttemptId);
                disposedAttemptIds.delete(context.lifecycleAttemptId);
                bindAttemptToConversation(context.lifecycleAttemptId, context.lifecycleConversationId);
                if (context.lifecycleConversationId) {
                    emitConversationIdResolvedSignal(context.lifecycleAttemptId, context.lifecycleConversationId);
                }
                emitLifecycleSignal(context.lifecycleAttemptId, 'prompt-sent', context.lifecycleConversationId);
            }

            if (!context.shouldEmitNonChatLifecycle || !context.fetchApiAdapter || !context.nonChatAttemptId) {
                return;
            }

            emitLifecycleSignal(
                context.nonChatAttemptId,
                'prompt-sent',
                context.nonChatConversationId,
                context.fetchApiAdapter.name,
            );
            if (context.fetchApiAdapter.name !== 'Gemini') {
                emitLifecycleSignal(
                    context.nonChatAttemptId,
                    'streaming',
                    context.nonChatConversationId,
                    context.fetchApiAdapter.name,
                );
            }

            if (
                context.fetchApiAdapter.name === 'Grok' &&
                shouldLogTransient(`grok:fetch:request:${context.nonChatAttemptId}`, 3000)
            ) {
                log('info', 'Grok fetch request intercepted', {
                    attemptId: context.nonChatAttemptId,
                    conversationId: context.nonChatConversationId ?? null,
                    method: context.outgoingMethod,
                    path: context.outgoingPath,
                });
            }
        };

        const maybeLogGeminiFetchDiscovery = (context: FetchInterceptorContext, response: Response): void => {
            if (
                !isDiscoveryDiagnosticsEnabled() ||
                !window.location.hostname.includes('gemini.google.com') ||
                context.outgoingMethod !== 'POST' ||
                !response.ok
            ) {
                return;
            }
            const contentType = response.headers.get('content-type') ?? '';
            log('info', '[DISCOVERY] Gemini fetch POST', {
                path: safePathname(context.outgoingUrl),
                status: response.status,
                contentType,
            });
        };

        const maybeMonitorFetchStreams = (context: FetchInterceptorContext, response: Response): void => {
            const contentType = response.headers.get('content-type') ?? '';
            if (context.isChatGptPromptRequest && contentType.includes('text/event-stream')) {
                void monitorChatGptSseLifecycle(
                    response.clone(),
                    context.lifecycleAttemptId ??
                        resolveAttemptIdForConversation(context.lifecycleConversationId, chatGPTAdapter.name),
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
                    context.nonChatConversationId,
                );
            }

            if (
                context.isNonChatGptApiRequest &&
                context.fetchApiAdapter?.name === 'Grok' &&
                context.nonChatAttemptId
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
                    context.nonChatConversationId,
                    context.outgoingUrl,
                    context.shouldEmitNonChatLifecycle,
                );
            }
        };

        const maybeRunCompletionFetchBackoff = (context: FetchInterceptorContext): void => {
            const completionAdapter = getPlatformAdapterByCompletionUrl(context.outgoingUrl);
            if (!completionAdapter) {
                return;
            }
            const requestHeaders = extractForwardableHeadersFromFetchArgs(context.args);
            void fetchFullConversationWithBackoff(completionAdapter, context.outgoingUrl, requestHeaders);
        };

        const interceptFetchRequest = async (args: Parameters<typeof fetch>): Promise<Response> => {
            const context = createFetchInterceptorContext(args);
            emitFetchPromptLifecycle(context);

            const response = await originalFetch(...args);
            maybeLogGeminiFetchDiscovery(context, response);
            maybeMonitorFetchStreams(context, response);
            maybeRunCompletionFetchBackoff(context);
            handleFetchInterception(args, response);
            return response;
        };

        window.fetch = (async (...args: Parameters<typeof fetch>) => interceptFetchRequest(args)) as any;

        // XHR Interceptor
        const XHR = window.XMLHttpRequest;
        const originalOpen = XHR.prototype.open;
        const originalSend = XHR.prototype.send;
        const originalSetRequestHeader = XHR.prototype.setRequestHeader;

        XHR.prototype.open = function (_method: string, url: string | URL, ...args: any[]) {
            (this as any)._url = String(url);
            (this as any)._method = _method;
            (this as any)._headers = {};
            return originalOpen.apply(this, [_method, url, ...args] as any);
        };

        XHR.prototype.setRequestHeader = function (header: string, value: string) {
            const existing = ((this as any)._headers as Record<string, string> | undefined) ?? {};
            existing[String(header).toLowerCase()] = String(value);
            (this as any)._headers = existing;
            return originalSetRequestHeader.call(this, header, value);
        };

        type XhrLifecycleContext = {
            methodUpper: string;
            requestUrl: string;
            requestAdapter: LLMPlatform | null;
            shouldEmitNonChatLifecycle: boolean;
            conversationId?: string;
            attemptId?: string;
        };

        const buildXhrLifecycleContext = (xhr: XMLHttpRequest): XhrLifecycleContext => {
            const method = ((xhr as any)._method as string | undefined) ?? 'GET';
            const requestUrl = ((xhr as any)._url as string | undefined) ?? '';
            const methodUpper = method.toUpperCase();
            const requestAdapter = methodUpper === 'POST' ? getPlatformAdapterByApiUrl(requestUrl) : null;
            const shouldEmitNonChatLifecycle =
                !!requestAdapter &&
                requestAdapter.name !== chatGPTAdapter.name &&
                shouldEmitNonChatLifecycleForRequest(requestAdapter, requestUrl);
            const conversationId =
                shouldEmitNonChatLifecycle && requestAdapter
                    ? resolveRequestConversationId(requestAdapter, requestUrl)
                    : undefined;
            const attemptId =
                shouldEmitNonChatLifecycle && requestAdapter
                    ? resolveAttemptIdForConversation(conversationId, requestAdapter.name)
                    : undefined;
            return {
                methodUpper,
                requestUrl,
                requestAdapter,
                shouldEmitNonChatLifecycle,
                conversationId,
                attemptId,
            };
        };

        const emitXhrRequestLifecycle = (xhr: XMLHttpRequest, context: XhrLifecycleContext): void => {
            if (
                !context.shouldEmitNonChatLifecycle ||
                !context.requestAdapter ||
                !context.attemptId ||
                !context.conversationId
            ) {
                return;
            }

            emitLifecycleSignal(context.attemptId, 'prompt-sent', context.conversationId, context.requestAdapter.name);

            if (context.requestAdapter.name === 'Gemini') {
                wireGeminiXhrProgressMonitor(xhr, context.attemptId, context.conversationId);
                return;
            }
            if (context.requestAdapter.name === 'Grok') {
                wireGrokXhrProgressMonitor(xhr, context.attemptId, context.conversationId);
                if (shouldLogTransient(`grok:xhr:request:${context.attemptId}`, 3000)) {
                    log('info', 'Grok XHR request intercepted', {
                        attemptId: context.attemptId,
                        conversationId: context.conversationId,
                        method: context.methodUpper,
                        path: safePathname(context.requestUrl),
                    });
                }
                return;
            }
            emitLifecycleSignal(context.attemptId, 'streaming', context.conversationId, context.requestAdapter.name);
        };

        const maybeLogGrokXhrResponse = (xhr: XMLHttpRequest, methodUpper: string): void => {
            const xhrUrl = ((xhr as any)._url as string | undefined) ?? '';
            const xhrAdapter = methodUpper === 'POST' ? getPlatformAdapterByApiUrl(xhrUrl) : null;
            if (xhrAdapter?.name !== 'Grok') {
                return;
            }
            const conversationId = resolveRequestConversationId(xhrAdapter, xhrUrl);
            const attemptId = resolveAttemptIdForConversation(conversationId, 'Grok');
            if (!shouldLogTransient(`grok:xhr:response:${attemptId}`, 3000)) {
                return;
            }
            log('info', 'Grok XHR response intercepted', {
                attemptId,
                conversationId: conversationId ?? null,
                status: xhr.status,
                size: xhr.responseText?.length ?? 0,
                path: safePathname(xhrUrl),
            });
        };

        const maybeLogGeminiXhrDiscovery = (xhr: XMLHttpRequest, methodUpper: string): void => {
            if (
                !isDiscoveryDiagnosticsEnabled() ||
                !window.location.hostname.includes('gemini.google.com') ||
                methodUpper !== 'POST' ||
                xhr.status !== 200
            ) {
                return;
            }
            const xhrUrl = ((xhr as any)._url as string | undefined) ?? '';
            log('info', '[DISCOVERY] Gemini XHR POST', {
                path: safePathname(xhrUrl),
                status: xhr.status,
                size: xhr.responseText?.length ?? 0,
            });
        };

        const maybeRunXhrCompletionFetch = (xhr: XMLHttpRequest): void => {
            const xhrUrl = ((xhr as any)._url as string | undefined) ?? '';
            const completionAdapter = getPlatformAdapterByCompletionUrl(xhrUrl);
            if (!completionAdapter) {
                return;
            }
            const requestHeaders = toForwardableHeaderRecord((xhr as any)._headers);
            void fetchFullConversationWithBackoff(completionAdapter, xhrUrl, requestHeaders);
        };

        const registerXhrLoadHandler = (xhr: XMLHttpRequest, methodUpper: string): void => {
            xhr.addEventListener('load', function () {
                const currentXhr = this as XMLHttpRequest;
                maybeLogGrokXhrResponse(currentXhr, methodUpper);
                maybeLogGeminiXhrDiscovery(currentXhr, methodUpper);
                maybeRunXhrCompletionFetch(currentXhr);
                handleXhrLoad(currentXhr, methodUpper);
            });
        };

        XHR.prototype.send = function (body?: any) {
            const xhr = this as XMLHttpRequest;
            const context = buildXhrLifecycleContext(xhr);
            emitXhrRequestLifecycle(xhr, context);
            registerXhrLoadHandler(xhr, context.methodUpper);
            return originalSend.call(this, body);
        };

        log('info', 'init', {
            host: window.location.hostname,
            runtimeTag: INTERCEPTOR_RUNTIME_TAG,
        });

        if (!(window as any).__blackiya) {
            const REQUEST_TYPE = 'BLACKIYA_GET_JSON_REQUEST';
            const RESPONSE_TYPE = 'BLACKIYA_GET_JSON_RESPONSE';
            const timeoutMs = 5000;

            const isResponseMessage = (event: MessageEvent, requestId: string) => {
                if (event.source !== window || event.origin !== window.location.origin) {
                    return false;
                }
                const message = event.data;
                return message?.type === RESPONSE_TYPE && message.requestId === requestId;
            };

            const makeRequestId = () => {
                if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
                    return crypto.randomUUID();
                }
                return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            };

            const requestJson = (format: 'original' | 'common') =>
                new Promise((resolve, reject) => {
                    const requestId = makeRequestId();
                    let timeoutId: number | undefined;

                    const cleanup = () => {
                        if (timeoutId !== undefined) {
                            clearTimeout(timeoutId);
                        }
                        window.removeEventListener('message', handler);
                    };

                    const handler = (event: MessageEvent) => {
                        if (!isResponseMessage(event, requestId)) {
                            return;
                        }
                        const message = event.data;
                        cleanup();
                        if (message.success) {
                            resolve(message.data);
                        } else {
                            reject(new Error(message.error || 'FAILED'));
                        }
                    };

                    window.addEventListener('message', handler);
                    window.postMessage({ type: REQUEST_TYPE, requestId, format }, window.location.origin);

                    timeoutId = window.setTimeout(() => {
                        cleanup();
                        reject(new Error('TIMEOUT'));
                    }, timeoutMs);
                });

            const handlePageSnapshotRequest = (event: MessageEvent) => {
                const message = isSnapshotRequestEvent(event);
                if (!message) {
                    return;
                }
                const conversationId = typeof message.conversationId === 'string' ? message.conversationId : '';
                const snapshot = conversationId ? getPageConversationSnapshot(conversationId) : null;
                const response = buildSnapshotResponse(message.requestId, snapshot);
                window.postMessage(response, window.location.origin);
            };

            const isSameWindowOriginEvent = (event: MessageEvent): boolean =>
                event.source === window && event.origin === window.location.origin;

            const parseAttemptDisposedMessage = (event: MessageEvent): AttemptDisposedMessage | null => {
                if (!isSameWindowOriginEvent(event)) {
                    return null;
                }
                const message = event.data as AttemptDisposedMessage;
                if (message?.type !== 'BLACKIYA_ATTEMPT_DISPOSED' || typeof message.attemptId !== 'string') {
                    return null;
                }
                return message;
            };

            const removeAttemptFromLatestPlatformMap = (attemptIdToRemove: string): void => {
                for (const [platform, attemptId] of latestAttemptIdByPlatform.entries()) {
                    if (attemptId === attemptIdToRemove) {
                        latestAttemptIdByPlatform.delete(platform);
                    }
                }
            };

            const removeAttemptFromConversationMap = (attemptIdToRemove: string): void => {
                for (const [conversationId, attemptId] of attemptByConversationId.entries()) {
                    if (attemptId === attemptIdToRemove) {
                        attemptByConversationId.delete(conversationId);
                    }
                }
            };

            const handleAttemptDisposed = (event: MessageEvent) => {
                const message = parseAttemptDisposedMessage(event);
                if (!message) {
                    return;
                }

                disposedAttemptIds.add(message.attemptId);
                streamDumpFrameCountByAttempt.delete(message.attemptId);
                streamDumpLastTextByAttempt.delete(message.attemptId);
                removeAttemptFromLatestPlatformMap(message.attemptId);
                removeAttemptFromConversationMap(message.attemptId);
            };

            const handleStreamDumpConfig = (event: MessageEvent) => {
                if (event.source !== window || event.origin !== window.location.origin) {
                    return;
                }
                const message = event.data as StreamDumpConfigMessage;
                if (message?.type !== 'BLACKIYA_STREAM_DUMP_CONFIG' || typeof message.enabled !== 'boolean') {
                    return;
                }

                streamDumpEnabled = message.enabled;
                if (!streamDumpEnabled) {
                    streamDumpFrameCountByAttempt.clear();
                    streamDumpLastTextByAttempt.clear();
                }
            };

            window.addEventListener('message', handlePageSnapshotRequest);
            window.addEventListener('message', handleAttemptDisposed);
            window.addEventListener('message', handleStreamDumpConfig);

            (window as any).__blackiya = {
                getJSON: () => requestJson('original'),
                getCommonJSON: () => requestJson('common'),
            };
        }
    },
});
