import { setupMainWorldBridge } from '@/entrypoints/interceptor/bootstrap-main-bridge';
import { createFetchInterceptor, markFetchFailureAsForwarded } from '@/entrypoints/interceptor/fetch-wrapper';
import {
    maybeCaptureGeminiBatchexecuteContext,
    resetGeminiBatchexecuteContext,
} from '@/entrypoints/interceptor/gemini-batchexecute-context-store';
import { conversationResponseCache } from '@/features/single-export/conversation-response-cache';
import {
    captureTerminalConversationResponse,
    captureTerminalConversationText,
} from '@/features/single-export/conversation-response-capture';
import { classifyGenerationEndpoint, type GenerationEndpoint } from '@/features/stream-debug/generation-endpoint';
import { streamDebugRecorder } from '@/features/stream-debug/recorder';
import { monitorFetchResponse } from '@/features/stream-debug/stream-monitor';
import { createXhrStreamCapture } from '@/features/stream-debug/xhr-monitor';
import { SUPPORTED_PLATFORM_URLS } from '@/platforms/constants';
import { getPlatformAdapter } from '@/platforms/factory';
import { extractMetaGraphqlRequestContext } from '@/platforms/meta/request';
import { MetaGraphqlResponseAssembler } from '@/platforms/meta/response-assembler';
import { isZaiConversationId, ZAI_HOST } from '@/platforms/zai/constants';
import { ZaiConversationResponseAssembler } from '@/platforms/zai/response-assembler';
import { platformHeaderStore } from '@/utils/platform-header-store';
import {
    extractForwardableHeadersFromFetchArgs,
    type SupportedPlatformName,
    toForwardableHeaderRecord,
} from '@/utils/proactive-fetch-headers';

const INTERCEPTOR_MARKER = '__BLACKIYA_INTERCEPTED__';
const GEMINI_BATCHEXECUTE_PATH = '/_/bardchatui/data/batchexecute';
const META_GRAPHQL_PATH = '/api/graphql';
const metaGraphqlResponseAssembler = new MetaGraphqlResponseAssembler();
const zaiConversationResponseAssembler = new ZaiConversationResponseAssembler();

const resolveUrlBase = (): string => {
    try {
        const origin = (globalThis as { window?: { location?: { origin?: unknown } } }).window?.location?.origin;
        return typeof origin === 'string' && /^https?:\/\//i.test(origin) ? origin : 'https://blackiya.invalid';
    } catch {
        return 'https://blackiya.invalid';
    }
};

const resolvePlatformName = (url: string): SupportedPlatformName | null => {
    try {
        const hostname = new URL(url, resolveUrlBase()).hostname.toLowerCase();
        if (hostname === 'chatgpt.com' || hostname === 'chat.openai.com') {
            return 'ChatGPT';
        }
        if (hostname === 'gemini.google.com' || hostname.endsWith('.gemini.google.com')) {
            return 'Gemini';
        }
        if (
            hostname === 'grok.com' ||
            hostname === 'www.grok.com' ||
            hostname === 'grok.x.com' ||
            hostname === 'x.com' ||
            hostname === 'www.x.com'
        ) {
            return 'Grok';
        }
        if (hostname === 'claude.ai') {
            return 'Claude';
        }
        if (hostname === 'chat.deepseek.com') {
            return 'DeepSeek';
        }
        if (hostname === 'chat.qwen.ai') {
            return 'Qwen';
        }
        if (hostname === 'chat.z.ai') {
            return 'Z.ai';
        }
        if (hostname === 'meta.ai' || hostname === 'www.meta.ai') {
            return 'Meta Muse';
        }
        if (hostname === 'nova.amazon.com') {
            return 'Amazon Nova';
        }
    } catch {
        return null;
    }
    return null;
};

export const isGeminiBatchexecutePost = (url: string, method: string): boolean => {
    if (method.toUpperCase() !== 'POST' || resolvePlatformName(url) !== 'Gemini') {
        return false;
    }
    try {
        const parsed = new URL(url, resolveUrlBase());
        return parsed.pathname.replace(/\/+$/, '').toLowerCase() === GEMINI_BATCHEXECUTE_PATH;
    } catch {
        return false;
    }
};

const framingFor = (platform: SupportedPlatformName) => {
    if (platform === 'ChatGPT' || platform === 'Qwen') {
        return 'sse' as const;
    }
    if (platform === 'Grok') {
        return 'line' as const;
    }
    return 'raw' as const;
};

const captureHeaders = (url: string, headers: ReturnType<typeof toForwardableHeaderRecord>) => {
    const platform = resolvePlatformName(url);
    if (platform && headers) {
        platformHeaderStore.update(platform, headers);
    }
};

export const invalidateCapturedRequestContext = (url: string, status: number): boolean => {
    if (status !== 401 && status !== 403) {
        return false;
    }
    const platform = resolvePlatformName(url);
    if (!platform) {
        return false;
    }
    platformHeaderStore.clear(platform);
    if (platform === 'Gemini') {
        resetGeminiBatchexecuteContext();
    }
    return true;
};

const extractRequestUrl = (input: RequestInfo | URL): string => {
    if (typeof input === 'string') {
        return input;
    }
    if (input instanceof URL) {
        return input.href;
    }
    return input.url;
};

const extractRequestMethod = (input: RequestInfo | URL, init?: RequestInit): string => {
    if (typeof init?.method === 'string' && init.method.length > 0) {
        return init.method.toUpperCase();
    }
    if (input instanceof Request && input.method) {
        return input.method.toUpperCase();
    }
    return 'GET';
};

const extractRequestHeaders = (input: RequestInfo | URL, init?: RequestInit): Headers => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
        new Headers(init.headers).forEach((value, name) => {
            headers.set(name, value);
        });
    }
    return headers;
};

const isMetaGraphqlPost = (url: string, method: string): boolean => {
    if (method.toUpperCase() !== 'POST') {
        return false;
    }
    try {
        const parsed = new URL(url, resolveUrlBase());
        return (
            (parsed.hostname === 'meta.ai' || parsed.hostname === 'www.meta.ai') &&
            parsed.pathname === META_GRAPHQL_PATH
        );
    } catch {
        return false;
    }
};

const readFetchRequestBody = async (args: Parameters<typeof fetch>): Promise<string | null> => {
    const body = args[1]?.body;
    if (typeof body === 'string') {
        return body;
    }
    if (body instanceof URLSearchParams) {
        return body.toString();
    }
    if (body === undefined && args[0] instanceof Request) {
        try {
            return await args[0].clone().text();
        } catch {
            return null;
        }
    }
    return null;
};

const prepareMetaFetchCapture = async (
    args: Parameters<typeof fetch>,
    url: string,
    method: string,
): Promise<string | null> => {
    if (!isMetaGraphqlPost(url, method)) {
        return null;
    }
    const body = await readFetchRequestBody(args);
    return body && extractMetaGraphqlRequestContext(body) ? body : null;
};

const captureMetaResponse = async (requestBody: string, response: Response): Promise<void> => {
    if (!response.ok) {
        return;
    }
    try {
        const data = metaGraphqlResponseAssembler.ingest(requestBody, await response.text());
        if (data) {
            conversationResponseCache.set('Meta Muse', data);
        }
    } catch {
        // Provider-specific cache assembly is opportunistic and never affects the page response.
    }
};

type ZaiCaptureContext = {
    url: string;
    method: 'GET' | 'POST';
    requestBody?: string;
};

const parseZaiCaptureEndpoint = (url: string, method: string): ZaiCaptureContext | null => {
    try {
        const parsed = new URL(url, resolveUrlBase());
        if (
            parsed.protocol !== 'https:' ||
            parsed.hostname !== ZAI_HOST ||
            parsed.search ||
            parsed.hash ||
            parsed.port ||
            parsed.username ||
            parsed.password
        ) {
            return null;
        }
        const detailId = parsed.pathname.match(/^\/api\/v1\/chats\/([^/]+)$/)?.[1];
        if (method.toUpperCase() === 'GET' && isZaiConversationId(detailId)) {
            return { url: parsed.href, method: 'GET' };
        }
        const batchId = parsed.pathname.match(/^\/api\/v1\/chats\/([^/]+)\/messages\/batch$/)?.[1];
        if (method.toUpperCase() === 'POST' && isZaiConversationId(batchId)) {
            return { url: parsed.href, method: 'POST' };
        }
    } catch {
        return null;
    }
    return null;
};

const prepareZaiFetchCapture = async (
    args: Parameters<typeof fetch>,
    url: string,
    method: string,
): Promise<ZaiCaptureContext | null> => {
    const context = parseZaiCaptureEndpoint(url, method);
    if (!context || context.method === 'GET') {
        return context;
    }
    const requestBody = await readFetchRequestBody(args);
    return requestBody ? { ...context, requestBody } : null;
};

const captureZaiResponse = async (context: ZaiCaptureContext, response: Response): Promise<void> => {
    if (!response.ok) {
        return;
    }
    try {
        const data = zaiConversationResponseAssembler.ingest({
            ...context,
            responseText: await response.text(),
        });
        if (data) {
            conversationResponseCache.set('Z.ai', data);
        }
    } catch {
        // Provider-specific cache assembly is opportunistic and never affects the page response.
    }
};

const defineScript = typeof defineContentScript !== 'undefined' ? defineContentScript : (config: any) => config;

export const captureFetchRequestContext = async (args: Parameters<typeof fetch>, url: string, method: string) => {
    const platform = resolvePlatformName(url);
    captureHeaders(url, extractForwardableHeadersFromFetchArgs(args, platform ?? undefined));
    if (!isGeminiBatchexecutePost(url, method)) {
        return;
    }

    try {
        let body: unknown = args[1]?.body;
        if (body === undefined && args[0] instanceof Request) {
            body = await args[0].clone().text();
        }
        maybeCaptureGeminiBatchexecuteContext(url, body);
    } catch {
        // Capturing diagnostics must never change the page request.
    }
};

const startFetchStreamCapture = (
    classification: GenerationEndpoint | null,
    method: string,
    url: string,
): string | undefined => {
    if (!classification) {
        return undefined;
    }
    try {
        return streamDebugRecorder.startStream({
            platform: classification.platform,
            endpoint: classification.endpoint,
            method,
            url,
            transport: 'fetch',
        });
    } catch {
        return undefined;
    }
};

const monitorFetchStream = (response: Response, streamId: string, classification: GenerationEndpoint) => {
    try {
        // The page owns the original response. Monitoring a clone is essential:
        // consuming the original body breaks ChatGPT's artifact Download action.
        void monitorFetchResponse(response.clone(), streamId, streamDebugRecorder, {
            framing: framingFor(classification.platform),
        });
    } catch {
        streamDebugRecorder.terminateStream(streamId, 'error');
    }
};

type FetchCapturePlan = {
    metaRequestBody: string | null;
    zaiCaptureContext: ZaiCaptureContext | null;
    classification: GenerationEndpoint | null;
    streamId: string | undefined;
};

const prepareFetchCapturePlan = async (
    args: Parameters<typeof fetch>,
    url: string,
    method: string,
): Promise<FetchCapturePlan> => {
    await captureFetchRequestContext(args, url, method);
    const [metaRequestBody, zaiCaptureContext] = await Promise.all([
        prepareMetaFetchCapture(args, url, method),
        prepareZaiFetchCapture(args, url, method),
    ]);
    const classification = classifyGenerationEndpoint(url, method);
    return {
        metaRequestBody,
        zaiCaptureContext,
        classification,
        streamId: startFetchStreamCapture(classification, method, url),
    };
};

const forwardPageFetch = async (
    originalFetch: typeof fetch,
    args: Parameters<typeof fetch>,
    streamId: string | undefined,
): Promise<Response> => {
    try {
        return await originalFetch(...args);
    } catch (error) {
        markFetchFailureAsForwarded(error);
        if (streamId) {
            streamDebugRecorder.terminateStream(streamId, 'error');
        }
        throw error;
    }
};

const withResponseClone = (response: Response, capture: (clone: Response) => void): void => {
    try {
        capture(response.clone());
    } catch {
        // A failed clone must not affect the page-owned response.
    }
};

const captureGenericFetchResponse = (
    response: Response,
    args: Parameters<typeof fetch>,
    url: string,
    method: string,
): void => {
    withResponseClone(response, (clone) => {
        void captureTerminalConversationResponse({
            response: clone,
            url,
            method,
            requestHeaders: extractRequestHeaders(args[0], args[1]),
            pageUrl: window.location.href,
            resolveAdapter: getPlatformAdapter,
            cache: conversationResponseCache,
        });
    });
};

const capturePlannedFetchResponse = (
    response: Response,
    plan: FetchCapturePlan,
    args: Parameters<typeof fetch>,
    url: string,
    method: string,
): void => {
    if (plan.metaRequestBody) {
        withResponseClone(response, (clone) => {
            void captureMetaResponse(plan.metaRequestBody!, clone);
        });
        return;
    }
    if (plan.zaiCaptureContext) {
        withResponseClone(response, (clone) => {
            void captureZaiResponse(plan.zaiCaptureContext!, clone);
        });
        return;
    }
    if (!plan.classification) {
        captureGenericFetchResponse(response, args, url, method);
    }
};

const createInterceptFetch = (originalFetch: typeof fetch) => async (args: Parameters<typeof fetch>) => {
    const url = extractRequestUrl(args[0]);
    const method = extractRequestMethod(args[0], args[1]);
    const plan = await prepareFetchCapturePlan(args, url, method);
    const response = await forwardPageFetch(originalFetch, args, plan.streamId);

    invalidateCapturedRequestContext(url, response.status);
    capturePlannedFetchResponse(response, plan, args, url, method);
    if (plan.classification && plan.streamId) {
        monitorFetchStream(response, plan.streamId, plan.classification);
    }
    return response;
};

type XhrProviderCapturePlan =
    | { kind: 'meta'; requestBody: string }
    | { kind: 'zai'; context: ZaiCaptureContext }
    | null;

const prepareXhrProviderCapture = (
    url: string,
    method: string,
    body: Document | XMLHttpRequestBodyInit | null | undefined,
): XhrProviderCapturePlan => {
    if (isMetaGraphqlPost(url, method) && typeof body === 'string' && extractMetaGraphqlRequestContext(body)) {
        return { kind: 'meta', requestBody: body };
    }
    const context = parseZaiCaptureEndpoint(url, method);
    if (!context) {
        return null;
    }
    return {
        kind: 'zai',
        context: context.method === 'POST' && typeof body === 'string' ? { ...context, requestBody: body } : context,
    };
};

const captureXhrProviderResponse = (plan: XhrProviderCapturePlan, xhr: XMLHttpRequest): boolean => {
    if (!plan) {
        return false;
    }
    try {
        const data =
            plan.kind === 'meta'
                ? metaGraphqlResponseAssembler.ingest(plan.requestBody, xhr.responseText)
                : zaiConversationResponseAssembler.ingest({ ...plan.context, responseText: xhr.responseText });
        if (data) {
            conversationResponseCache.set(plan.kind === 'meta' ? 'Meta Muse' : 'Z.ai', data);
        }
    } catch {
        // Some XHR response types make responseText inaccessible.
    }
    return true;
};

const captureGenericXhrResponse = (xhr: XMLHttpRequest, url: string, method: string): void => {
    try {
        captureTerminalConversationText({
            text: xhr.responseText,
            url,
            method,
            requestHeaders: (xhr as any).__blackiyaRequestHeaders,
            pageUrl: window.location.href,
            resolveAdapter: getPlatformAdapter,
            cache: conversationResponseCache,
        });
    } catch {
        // Some XHR response types make responseText inaccessible.
    }
};

const handleXhrLoad = (
    xhr: XMLHttpRequest,
    url: string,
    method: string,
    providerPlan: XhrProviderCapturePlan,
): void => {
    invalidateCapturedRequestContext(url, xhr.status);
    if (xhr.status < 200 || xhr.status >= 300 || captureXhrProviderResponse(providerPlan, xhr)) {
        return;
    }
    if (!classifyGenerationEndpoint(url, method)) {
        captureGenericXhrResponse(xhr, url, method);
    }
};

const captureGeminiXhrContext = (
    url: string,
    method: string,
    body: Document | XMLHttpRequestBodyInit | null | undefined,
): void => {
    if (!isGeminiBatchexecutePost(url, method)) {
        return;
    }
    try {
        maybeCaptureGeminiBatchexecuteContext(url, body);
    } catch {
        // Safe non-interference boundary.
    }
};

const installXhrStreamCapture = (xhr: XMLHttpRequest, url: string, method: string): void => {
    const classification = classifyGenerationEndpoint(url, method);
    if (!classification) {
        return;
    }
    try {
        const streamId = streamDebugRecorder.startStream({
            platform: classification.platform,
            endpoint: classification.endpoint,
            method,
            url,
            transport: 'xhr',
        });
        const capture = createXhrStreamCapture({
            streamId,
            recorder: streamDebugRecorder,
            framing: framingFor(classification.platform),
            readResponseText: () => xhr.responseText,
        });
        xhr.addEventListener('progress', capture.progress);
        xhr.addEventListener('load', capture.load);
        xhr.addEventListener('loadend', capture.loadEnd);
        xhr.addEventListener('abort', capture.abort);
        xhr.addEventListener('error', capture.error);
    } catch {
        // Safe non-interference boundary.
    }
};

export default defineScript({
    matches: [...SUPPORTED_PLATFORM_URLS],
    world: 'MAIN',
    runAt: 'document_start',
    main() {
        if ((window as any)[INTERCEPTOR_MARKER] === true) {
            return;
        }
        (window as any)[INTERCEPTOR_MARKER] = true;

        const originalFetch = window.fetch.bind(window);
        const interceptFetch = createInterceptFetch(originalFetch);

        window.fetch = createFetchInterceptor(originalFetch, async (input, init) =>
            interceptFetch([input, init] as Parameters<typeof fetch>),
        );

        const xhrPrototype = window.XMLHttpRequest.prototype;
        const originalOpen = xhrPrototype.open;
        const originalSend = xhrPrototype.send;
        const originalSetRequestHeader = xhrPrototype.setRequestHeader;

        xhrPrototype.open = function (method: string, url: string | URL, ...rest: any[]) {
            (this as any).__blackiyaRequestUrl = String(url);
            (this as any).__blackiyaRequestMethod = method.toUpperCase();
            (this as any).__blackiyaRequestHeaders = {};
            return originalOpen.apply(this, [method, url, ...rest] as any);
        };

        xhrPrototype.setRequestHeader = function (name: string, value: string) {
            const headers = ((this as any).__blackiyaRequestHeaders as Record<string, string> | undefined) ?? {};
            headers[name] = value;
            (this as any).__blackiyaRequestHeaders = headers;
            const requestUrl = String((this as any).__blackiyaRequestUrl ?? '');
            captureHeaders(
                requestUrl,
                toForwardableHeaderRecord(headers, resolvePlatformName(requestUrl) ?? undefined),
            );
            return originalSetRequestHeader.call(this, name, value);
        };

        xhrPrototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
            const xhr = this as XMLHttpRequest;
            const url = String((xhr as any).__blackiyaRequestUrl ?? '');
            const method = String((xhr as any).__blackiyaRequestMethod ?? 'GET').toUpperCase();
            const providerPlan = prepareXhrProviderCapture(url, method, body);
            xhr.addEventListener('load', () => handleXhrLoad(xhr, url, method, providerPlan));
            captureHeaders(
                url,
                toForwardableHeaderRecord((xhr as any).__blackiyaRequestHeaders, resolvePlatformName(url) ?? undefined),
            );

            captureGeminiXhrContext(url, method, body);
            installXhrStreamCapture(xhr, url, method);

            return originalSend.call(this, body);
        };

        setupMainWorldBridge();
    },
});
