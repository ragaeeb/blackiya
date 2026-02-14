import { SUPPORTED_PLATFORM_URLS } from '@/platforms/constants';
import { getPlatformAdapterByApiUrl, getPlatformAdapterByCompletionUrl } from '@/platforms/factory';
import type { LLMPlatform } from '@/platforms/types';
import { isConversationReady } from '@/utils/conversation-readiness';
import {
    extractForwardableHeadersFromFetchArgs,
    type HeaderRecord,
    mergeHeaderRecords,
    toForwardableHeaderRecord,
} from '@/utils/proactive-fetch-headers';

interface CapturePayload {
    type: 'LLM_CAPTURE_DATA_INTERCEPTED';
    url: string;
    data: string;
    platform: string;
}

interface RawCaptureSnapshot {
    __blackiyaSnapshotType: 'raw-capture';
    data: string;
    url: string;
    platform: string;
    conversationId?: string;
}

interface InterceptorLogPayload {
    type: 'LLM_LOG_ENTRY';
    payload: {
        level: 'info' | 'warn' | 'error';
        message: string;
        data: any[];
        context: 'interceptor';
    };
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

interface ResponseFinishedSignal {
    type: 'BLACKIYA_RESPONSE_FINISHED';
    platform: string;
    source: 'network';
    conversationId?: string;
}

const completionSignalCache = new Map<string, number>();
const transientLogCache = new Map<string, number>();

function log(level: 'info' | 'warn' | 'error', message: string, data?: any) {
    // Keep console output for immediate debugging in the page console
    const displayData = data ? ` ${JSON.stringify(data)}` : '';
    if (level === 'error') {
        console.error(message + displayData);
    } else if (level === 'warn') {
        console.warn(message + displayData);
    } else {
        console.log(message + displayData);
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

function emitResponseFinishedSignal(adapter: LLMPlatform, url: string): void {
    const conversationId = adapter.extractConversationIdFromUrl?.(url) ?? undefined;
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
        source: 'network',
        conversationId,
    };
    window.postMessage(payload, window.location.origin);
    log('info', 'response finished hint', {
        platform: adapter.name,
        conversationId: conversationId ?? null,
        path: safePathname(url),
    });
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

function appendHeadersToRecord(target: Record<string, string>, headers: HeadersInit | undefined): void {
    if (!headers) {
        return;
    }

    if (headers instanceof Headers) {
        headers.forEach((value, key) => {
            target[key.toLowerCase()] = value;
        });
        return;
    }

    if (Array.isArray(headers)) {
        for (const [key, value] of headers) {
            target[String(key).toLowerCase()] = String(value);
        }
        return;
    }

    for (const [key, value] of Object.entries(headers)) {
        target[key.toLowerCase()] = String(value);
    }
}

function collectFetchRequestHeaders(args: Parameters<typeof fetch>): Record<string, string> | undefined {
    const headers: Record<string, string> = {};
    if (args[0] instanceof Request) {
        appendHeadersToRecord(headers, args[0].headers);
    }
    appendHeadersToRecord(headers, args[1]?.headers);
    return Object.keys(headers).length > 0 ? headers : undefined;
}

function sanitizeHeaderValueForLog(name: string, value: string): string {
    const normalized = name.toLowerCase();
    const trimmed = value.trim();
    if (
        normalized === 'authorization' ||
        normalized.includes('token') ||
        normalized.includes('cookie') ||
        normalized.includes('csrf') ||
        normalized.includes('api-key')
    ) {
        return `<redacted:${trimmed.length}>`;
    }

    if (trimmed.length > 140) {
        return `${trimmed.slice(0, 140)}...`;
    }

    return trimmed;
}

function sanitizeHeadersForLog(headers: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!headers) {
        return undefined;
    }

    const sanitized: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        sanitized[name] = sanitizeHeaderValueForLog(name, value);
    }
    return sanitized;
}

function emitCapturePayload(url: string, data: string, platform: string): void {
    const payload: CapturePayload = {
        type: 'LLM_CAPTURE_DATA_INTERCEPTED',
        url,
        data,
        platform,
    };
    queueInterceptedMessage(payload);
    window.postMessage(payload, window.location.origin);
}

function handleApiMatchFromFetch(url: string, adapterName: string, response: Response): void {
    log('info', `API match ${adapterName}`);
    const clonedResponse = response.clone();
    clonedResponse
        .text()
        .then((text) => {
            log('info', `API ${text.length}b ${adapterName}`);
            emitCapturePayload(url, text, adapterName);
        })
        .catch(() => {
            log('error', `API read err ${adapterName}`);
        });
}

function tryParseAndEmitConversation(adapter: LLMPlatform, url: string, text: string, source: string): boolean {
    try {
        const parsed = adapter.parseInterceptedData(text, url);
        if (parsed?.conversation_id) {
            log('info', `${source} captured ${adapter.name} ${parsed.conversation_id}`);
            emitCapturePayload(url, JSON.stringify(parsed), adapter.name);
            return true;
        }
    } catch {
        // Ignore parse failures for auxiliary endpoints
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
        handleApiMatchFromFetch(url, apiAdapter.name, response);
        if (completionAdapter) {
            emitResponseFinishedSignal(completionAdapter, url);
        }
        return;
    }

    if (completionAdapter) {
        emitResponseFinishedSignal(completionAdapter, url);
        inspectAuxConversationFetch(url, response, completionAdapter);
        return;
    }

    if (url.includes('/backend-api/conversation/')) {
        logConversationSkip('API', url);
        return;
    }

    const method = getRequestMethod(args);
    if (method === 'POST' && response.ok && isDiscoveryModeHost(window.location.hostname)) {
        logDiscoveryFetch(url, response);
    }
}

function logDiscoveryXhr(url: string, responseText: string): void {
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
}

function handleXhrLoad(xhr: XMLHttpRequest, method: string): void {
    const url = (xhr as any)._url;
    const adapter = getPlatformAdapterByApiUrl(url);
    const completionAdapter = getPlatformAdapterByCompletionUrl(url);

    if (processXhrApiMatch(url, xhr, adapter)) {
        if (completionAdapter) {
            emitResponseFinishedSignal(completionAdapter, url);
        }
        return;
    }

    processXhrAuxConversation(url, xhr, completionAdapter);
    if (completionAdapter) {
        emitResponseFinishedSignal(completionAdapter, url);
        return;
    }

    if (url.includes('/backend-api/conversation/')) {
        logConversationSkip('XHR', url);
        return;
    }

    if (isDiscoveryModeHost(window.location.hostname) && method === 'POST' && xhr.status === 200) {
        try {
            logDiscoveryXhr(url, xhr.responseText);
        } catch {
            // Ignore errors in discovery mode
        }
    }
}

function processXhrApiMatch(url: string, xhr: XMLHttpRequest, adapter: LLMPlatform | null): boolean {
    if (!adapter) {
        return false;
    }

    try {
        log('info', `XHR API ${adapter.name}`);
        emitCapturePayload(url, xhr.responseText, adapter.name);
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

export default defineContentScript({
    matches: [...SUPPORTED_PLATFORM_URLS],
    world: 'MAIN',
    runAt: 'document_start',
    main() {
        // Idempotency: prevent double-injection if the extension is reloaded or content script runs twice
        if ((window as any).__BLACKIYA_INTERCEPTED__) {
            log('warn', 'already init');
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
        const inFlightFetches = new Map<string, Promise<void>>();
        const proactiveHeadersByKey = new Map<string, HeaderRecord>();
        // ChatGPT can materialize the full conversation payload late; keep retries bounded but longer.
        const proactiveBackoffMs = [900, 1800, 3200, 5000, 7000, 9000, 12000, 15000];

        const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

        const tryFetchConversation = async (
            adapter: LLMPlatform,
            conversationId: string,
            attempt: number,
            apiUrl: string,
            requestHeaders?: HeaderRecord,
        ) => {
            try {
                log('info', `fetching ${conversationId}`, { attempt });
                if (attempt === 1 && requestHeaders) {
                    log('info', 'proactive fetch request headers', {
                        conversationId,
                        path: safePathname(apiUrl),
                        headers: sanitizeHeadersForLog(requestHeaders),
                    });
                }
                const response = await originalFetch(apiUrl, {
                    credentials: 'include',
                    headers: requestHeaders,
                });
                log('info', 'fetch response', {
                    conversationId,
                    ok: response.ok,
                    status: response.status,
                    attempt,
                });

                if (!response.ok) {
                    return false;
                }

                const text = await response.text();
                const parsed = adapter.parseInterceptedData(text, apiUrl);
                const isComplete = !!parsed?.conversation_id && isConversationReady(parsed);
                if (!isComplete) {
                    log('info', 'fetch payload incomplete', {
                        conversationId,
                        attempt,
                        path: safePathname(apiUrl),
                        bytes: text.length,
                        parsedConversationId: parsed?.conversation_id ?? null,
                    });
                    return false;
                }

                log('info', `fetched ${conversationId} ${text.length}b`, {
                    path: safePathname(apiUrl),
                });
                emitCapturePayload(apiUrl, JSON.stringify(parsed), adapter.name);
                return true;
            } catch (error) {
                log('error', `fetch err ${conversationId}`, {
                    attempt,
                    error: error instanceof Error ? error.message : String(error),
                });
                return false;
            }
        };

        const runProactiveFetch = async (adapter: LLMPlatform, conversationId: string, key: string) => {
            for (let attempt = 0; attempt < proactiveBackoffMs.length; attempt++) {
                await delay(proactiveBackoffMs[attempt]);
                const apiUrls = getApiUrlCandidates(adapter, conversationId);
                const requestHeaders = proactiveHeadersByKey.get(key);
                for (const apiUrl of apiUrls) {
                    const success = await tryFetchConversation(
                        adapter,
                        conversationId,
                        attempt + 1,
                        apiUrl,
                        requestHeaders,
                    );
                    if (success) {
                        return;
                    }
                }
            }
            log('info', `fetch gave up ${conversationId}`);
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
            const mergedHeaders = mergeHeaderRecords(proactiveHeadersByKey.get(key), requestHeaders);
            if (mergedHeaders) {
                proactiveHeadersByKey.set(key, mergedHeaders);
            }

            if (inFlightFetches.has(key)) {
                return;
            }

            log('info', `trigger ${adapter.name} ${conversationId}`);

            const run = runProactiveFetch(adapter, conversationId, key);

            inFlightFetches.set(key, run);
            run.finally(() => {
                inFlightFetches.delete(key);
                proactiveHeadersByKey.delete(key);
            });
        };

        window.fetch = (async (...args: Parameters<typeof fetch>) => {
            const outgoingUrl = getRequestUrl(args[0]);
            const outgoingMethod = getRequestMethod(args);
            if (outgoingUrl.includes('/backend-api/')) {
                const path = safePathname(outgoingUrl);
                if (shouldLogTransient(`outgoing:fetch:${outgoingMethod}:${path}`, 2500)) {
                    log('info', 'outgoing request', {
                        channel: 'fetch',
                        method: outgoingMethod,
                        path,
                        headers: sanitizeHeadersForLog(collectFetchRequestHeaders(args)),
                    });
                }
            }

            const response = await originalFetch(...args);
            const url = outgoingUrl;
            const completionAdapter = getPlatformAdapterByCompletionUrl(url);
            if (completionAdapter) {
                const requestHeaders = extractForwardableHeadersFromFetchArgs(args);
                void fetchFullConversationWithBackoff(completionAdapter, url, requestHeaders);
            }
            handleFetchInterception(args, response);
            return response;
        }) as any;

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

        XHR.prototype.send = function (body?: any) {
            const method = (this as any)._method || 'GET';
            const xhrUrl = (this as any)._url;
            if (typeof xhrUrl === 'string' && xhrUrl.includes('/backend-api/')) {
                const path = safePathname(xhrUrl);
                if (shouldLogTransient(`outgoing:xhr:${method}:${path}`, 2500)) {
                    log('info', 'outgoing request', {
                        channel: 'xhr',
                        method,
                        path,
                        headers: sanitizeHeadersForLog(toForwardableHeaderRecord((this as any)._headers)),
                    });
                }
            }
            this.addEventListener('load', function () {
                const xhr = this as XMLHttpRequest;
                const completionAdapter = getPlatformAdapterByCompletionUrl((xhr as any)._url);
                if (completionAdapter) {
                    const requestHeaders = toForwardableHeaderRecord((xhr as any)._headers);
                    void fetchFullConversationWithBackoff(completionAdapter, (xhr as any)._url, requestHeaders);
                }
                handleXhrLoad(xhr, method);
            });
            return originalSend.call(this, body);
        };

        log('info', 'init');

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

            window.addEventListener('message', handlePageSnapshotRequest);

            (window as any).__blackiya = {
                getJSON: () => requestJson('original'),
                getCommonJSON: () => requestJson('common'),
            };
        }
    },
});
