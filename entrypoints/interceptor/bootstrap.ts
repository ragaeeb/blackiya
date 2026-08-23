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
    isDeclaredBodyOversized,
    isTextWithinByteLimit,
    readBoundedBodyText,
} from '@/features/single-export/conversation-response-capture';
import { classifyGenerationEndpoint, type GenerationEndpoint } from '@/features/stream-debug/generation-endpoint';
import { streamDebugRecorder } from '@/features/stream-debug/recorder';
import { createMonitoredFetchResponse } from '@/features/stream-debug/stream-monitor';
import { createXhrStreamCapture } from '@/features/stream-debug/xhr-monitor';
import { parseClaudeConversationApiUrl } from '@/platforms/claude/request';
import { SUPPORTED_PLATFORM_URLS } from '@/platforms/constants';
import { parseDeepSeekHistoryRequestContext } from '@/platforms/deepseek/request';
import { getPlatformAdapter } from '@/platforms/factory';
import { extractConversationIdFromSourcePath } from '@/platforms/gemini/rpc-parser';
import { extractMetaGraphqlRequestContext, type MetaGraphqlContextCandidate } from '@/platforms/meta/request';
import { MetaGraphqlResponseAssembler } from '@/platforms/meta/response-assembler';
import { extractQwenConversationIdFromDetailUrl } from '@/platforms/qwen/requests';
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
const providerStateEpochs = new Map<SupportedPlatformName, number>();

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

const getProviderStateEpoch = (platform: SupportedPlatformName): number => providerStateEpochs.get(platform) ?? 0;

const advanceProviderStateEpoch = (platform: SupportedPlatformName): void => {
    const current = getProviderStateEpoch(platform);
    providerStateEpochs.set(platform, current >= Number.MAX_SAFE_INTEGER ? 0 : current + 1);
};

const isProviderStateEpochCurrent = (platform: SupportedPlatformName, epoch: number): boolean =>
    getProviderStateEpoch(platform) === epoch;

const clearProviderConversationState = (platform: SupportedPlatformName): void => {
    advanceProviderStateEpoch(platform);
    conversationResponseCache.clear(platform);
    if (platform === 'Meta Muse') {
        metaGraphqlResponseAssembler.clear();
    } else if (platform === 'Z.ai') {
        zaiConversationResponseAssembler.clear();
    }
};

const invalidateConversationSnapshot = (platform: SupportedPlatformName, conversationId: string): void => {
    advanceProviderStateEpoch(platform);
    conversationResponseCache.delete(platform, conversationId);
};

const resolveDeterministicDetailConversation = (
    url: string,
    method: string,
): { platform: SupportedPlatformName; conversationId: string } | null => {
    const adapter = getPlatformAdapter(url);
    const platform = resolvePlatformName(url);
    if (!adapter?.isConversationDetailRequest?.(url, method) || !platform || adapter.name !== platform) {
        return null;
    }

    let conversationId: string | null = null;
    if (platform === 'ChatGPT') {
        try {
            conversationId = new URL(url).pathname.match(/^\/backend-api\/(?:f\/)?conversation\/([^/]+)$/)?.[1] ?? null;
        } catch {
            return null;
        }
    } else if (platform === 'Gemini') {
        conversationId = extractConversationIdFromSourcePath(url);
    } else if (platform === 'Claude') {
        conversationId = parseClaudeConversationApiUrl(url)?.conversationId ?? null;
    } else if (platform === 'Qwen') {
        conversationId = extractQwenConversationIdFromDetailUrl(url);
    } else if (platform === 'DeepSeek') {
        conversationId = parseDeepSeekHistoryRequestContext(url)?.conversationId ?? null;
    }

    return conversationId ? { platform, conversationId } : null;
};

const invalidateDeterministicDetailRequestStart = (url: string, method: string): void => {
    const detail = resolveDeterministicDetailConversation(url, method);
    if (detail) {
        conversationResponseCache.delete(detail.platform, detail.conversationId);
    }
};

const invalidateActiveConversationForGeneration = (url: string, classification: GenerationEndpoint | null): void => {
    const requestAdapter = classification ? getPlatformAdapter(url) : null;
    if (!classification || !requestAdapter || requestAdapter.name !== classification.platform) {
        return;
    }
    const pageUrl = window.location.href;
    const adapter = getPlatformAdapter(pageUrl);
    if (!adapter || adapter.name !== classification.platform) {
        return;
    }
    const conversationId = adapter.extractConversationId(pageUrl);
    if (conversationId) {
        invalidateConversationSnapshot(classification.platform, conversationId);
    }
};

const captureHeaders = (url: string, headers: ReturnType<typeof toForwardableHeaderRecord>) => {
    const platform = resolvePlatformName(url);
    if (platform && headers && platformHeaderStore.update(platform, headers)) {
        clearProviderConversationState(platform);
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
    clearProviderConversationState(platform);
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

const formEncodedComponentLength = (value: string): number => {
    let length = 0;
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        const isUnescaped =
            (codePoint >= 0x30 && codePoint <= 0x39) ||
            (codePoint >= 0x41 && codePoint <= 0x5a) ||
            (codePoint >= 0x61 && codePoint <= 0x7a) ||
            codePoint === 0x2a ||
            codePoint === 0x2d ||
            codePoint === 0x2e ||
            codePoint === 0x5f ||
            codePoint === 0x20;
        if (isUnescaped) {
            length += 1;
        } else if (codePoint <= 0x7f) {
            length += 3;
        } else if (codePoint <= 0x7ff) {
            length += 6;
        } else if (codePoint <= 0xffff) {
            length += 9;
        } else {
            length += 12;
        }
    }
    return length;
};

const isUrlSearchParamsWithinByteLimit = (body: URLSearchParams, maxBytes: number): boolean => {
    let byteLength = 0;
    let parameterCount = 0;
    for (const [name, value] of body) {
        byteLength += (parameterCount > 0 ? 1 : 0) + formEncodedComponentLength(name) + 1;
        byteLength += formEncodedComponentLength(value);
        if (byteLength > maxBytes) {
            return false;
        }
        parameterCount += 1;
    }
    return true;
};

const readFetchRequestBody = async (args: Parameters<typeof fetch>, maxBytes: number): Promise<string | null> => {
    const body = args[1]?.body;
    if (typeof body === 'string') {
        return isTextWithinByteLimit(body, maxBytes) ? body : null;
    }
    if (body instanceof URLSearchParams) {
        return isUrlSearchParamsWithinByteLimit(body, maxBytes) ? body.toString() : null;
    }
    if (body === undefined && args[0] instanceof Request) {
        if (isDeclaredBodyOversized(args[0], maxBytes)) {
            return null;
        }
        try {
            return await readBoundedBodyText(args[0].clone(), maxBytes);
        } catch {
            return null;
        }
    }
    return null;
};

type MetaCaptureContext = {
    requestBody: string;
    requestContext: MetaGraphqlContextCandidate;
};

const prepareMetaFetchCapture = async (
    args: Parameters<typeof fetch>,
    url: string,
    method: string,
): Promise<MetaCaptureContext | null> => {
    if (!isMetaGraphqlPost(url, method)) {
        return null;
    }
    const body = await readFetchRequestBody(args, conversationResponseCache.getMaxBytesPerEntry());
    if (!body) {
        return null;
    }
    const requestContext = extractMetaGraphqlRequestContext(body);
    return requestContext ? { requestBody: body, requestContext } : null;
};

const captureMetaResponse = async (requestBody: string, response: Response, epoch: number): Promise<void> => {
    if (!response.ok) {
        return;
    }
    try {
        const responseText = await readBoundedBodyText(response, conversationResponseCache.getMaxBytesPerEntry());
        if (responseText === null || !isProviderStateEpochCurrent('Meta Muse', epoch)) {
            return;
        }
        const data = metaGraphqlResponseAssembler.ingest(requestBody, responseText);
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
    conversationId: string;
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
            return { url: parsed.href, method: 'GET', conversationId: detailId };
        }
        const batchId = parsed.pathname.match(/^\/api\/v1\/chats\/([^/]+)\/messages\/batch$/)?.[1];
        if (method.toUpperCase() === 'POST' && isZaiConversationId(batchId)) {
            return { url: parsed.href, method: 'POST', conversationId: batchId };
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
    const requestBody = await readFetchRequestBody(args, conversationResponseCache.getMaxBytesPerEntry());
    return requestBody ? { ...context, requestBody } : null;
};

const captureZaiResponse = async (context: ZaiCaptureContext, response: Response, epoch: number): Promise<void> => {
    if (!response.ok) {
        return;
    }
    try {
        const responseText = await readBoundedBodyText(response, conversationResponseCache.getMaxBytesPerEntry());
        if (responseText === null || !isProviderStateEpochCurrent('Z.ai', epoch)) {
            return;
        }
        const data = zaiConversationResponseAssembler.ingest({
            ...context,
            responseText,
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

const monitorFetchStream = (response: Response, streamId: string, classification: GenerationEndpoint): Response => {
    try {
        return createMonitoredFetchResponse(response, streamId, streamDebugRecorder, {
            framing: framingFor(classification.platform),
        });
    } catch {
        streamDebugRecorder.terminateStream(streamId, 'error');
        return response;
    }
};

type ProviderCaptureEpoch = { platform: SupportedPlatformName; value: number };

type FetchCapturePlan = {
    metaCaptureContext: MetaCaptureContext | null;
    zaiCaptureContext: ZaiCaptureContext | null;
    classification: GenerationEndpoint | null;
    streamId: string | undefined;
    captureEpoch: ProviderCaptureEpoch | null;
};

const prepareFetchCapturePlan = async (
    args: Parameters<typeof fetch>,
    url: string,
    method: string,
): Promise<FetchCapturePlan> => {
    await captureFetchRequestContext(args, url, method);
    const classification = classifyGenerationEndpoint(url, method, window.location.href);
    invalidateActiveConversationForGeneration(url, classification);
    invalidateDeterministicDetailRequestStart(url, method);
    const platform = resolvePlatformName(url);
    const captureEpoch = platform ? { platform, value: getProviderStateEpoch(platform) } : null;
    const [metaCaptureContext, zaiCaptureContext] = await Promise.all([
        prepareMetaFetchCapture(args, url, method),
        prepareZaiFetchCapture(args, url, method),
    ]);
    if (metaCaptureContext?.requestContext.kind === 'conversation-detail') {
        conversationResponseCache.delete('Meta Muse', metaCaptureContext.requestContext.conversationId);
    }
    if (zaiCaptureContext?.method === 'GET') {
        conversationResponseCache.delete('Z.ai', zaiCaptureContext.conversationId);
    }
    return {
        metaCaptureContext,
        zaiCaptureContext,
        classification,
        streamId: startFetchStreamCapture(classification, method, url),
        captureEpoch,
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
    if (isDeclaredBodyOversized(response, conversationResponseCache.getMaxBytesPerEntry())) {
        return;
    }
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
    captureEpoch: ProviderCaptureEpoch,
): void => {
    void captureTerminalConversationResponse({
        response,
        url,
        method,
        requestHeaders: extractRequestHeaders(args[0], args[1]),
        pageUrl: window.location.href,
        resolveAdapter: getPlatformAdapter,
        cache: conversationResponseCache,
        canMutate: (platformName) =>
            platformName === captureEpoch.platform &&
            isProviderStateEpochCurrent(captureEpoch.platform, captureEpoch.value),
        onNonTerminal: (platformName, conversationId) => {
            if (
                platformName === captureEpoch.platform &&
                isProviderStateEpochCurrent(captureEpoch.platform, captureEpoch.value)
            ) {
                invalidateConversationSnapshot(captureEpoch.platform, conversationId);
            }
        },
    });
};

const capturePlannedFetchResponse = (
    response: Response,
    plan: FetchCapturePlan,
    args: Parameters<typeof fetch>,
    url: string,
    method: string,
): void => {
    const captureEpoch = plan.captureEpoch;
    if (!captureEpoch || !isProviderStateEpochCurrent(captureEpoch.platform, captureEpoch.value)) {
        return;
    }
    if (plan.metaCaptureContext) {
        if (captureEpoch.platform !== 'Meta Muse') {
            return;
        }
        withResponseClone(response, (clone) => {
            void captureMetaResponse(plan.metaCaptureContext!.requestBody, clone, captureEpoch.value);
        });
        return;
    }
    if (plan.zaiCaptureContext) {
        if (captureEpoch.platform !== 'Z.ai') {
            return;
        }
        withResponseClone(response, (clone) => {
            void captureZaiResponse(plan.zaiCaptureContext!, clone, captureEpoch.value);
        });
        return;
    }
    if (!plan.classification) {
        captureGenericFetchResponse(response, args, url, method, captureEpoch);
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
        return monitorFetchStream(response, plan.streamId, plan.classification);
    }
    return response;
};

type XhrProviderCapturePlan =
    | { kind: 'meta'; captureContext: MetaCaptureContext }
    | { kind: 'zai'; context: ZaiCaptureContext }
    | null;

const prepareXhrProviderCapture = (
    url: string,
    method: string,
    body: Document | XMLHttpRequestBodyInit | null | undefined,
): XhrProviderCapturePlan => {
    const maxBytes = conversationResponseCache.getMaxBytesPerEntry();
    if (isMetaGraphqlPost(url, method) && typeof body === 'string' && isTextWithinByteLimit(body, maxBytes)) {
        const requestContext = extractMetaGraphqlRequestContext(body);
        if (!requestContext) {
            return null;
        }
        return {
            kind: 'meta',
            captureContext: { requestBody: body, requestContext },
        };
    }
    const context = parseZaiCaptureEndpoint(url, method);
    if (!context) {
        return null;
    }
    if (context.method === 'POST' && (typeof body !== 'string' || !isTextWithinByteLimit(body, maxBytes))) {
        return null;
    }
    return {
        kind: 'zai',
        context: context.method === 'POST' && typeof body === 'string' ? { ...context, requestBody: body } : context,
    };
};

const captureXhrProviderResponse = (
    plan: XhrProviderCapturePlan,
    xhr: XMLHttpRequest,
    captureEpoch: ProviderCaptureEpoch | null,
): boolean => {
    if (!plan) {
        return false;
    }
    const platform = plan.kind === 'meta' ? 'Meta Muse' : 'Z.ai';
    if (
        !captureEpoch ||
        captureEpoch.platform !== platform ||
        !isProviderStateEpochCurrent(platform, captureEpoch.value)
    ) {
        return true;
    }
    try {
        const data =
            plan.kind === 'meta'
                ? metaGraphqlResponseAssembler.ingest(plan.captureContext.requestBody, xhr.responseText)
                : zaiConversationResponseAssembler.ingest({ ...plan.context, responseText: xhr.responseText });
        if (data) {
            conversationResponseCache.set(plan.kind === 'meta' ? 'Meta Muse' : 'Z.ai', data);
        }
    } catch {
        // Some XHR response types make responseText inaccessible.
    }
    return true;
};

const captureGenericXhrResponse = (
    xhr: XMLHttpRequest,
    url: string,
    method: string,
    captureEpoch: ProviderCaptureEpoch,
): void => {
    try {
        captureTerminalConversationText({
            text: xhr.responseText,
            url,
            method,
            requestHeaders: (xhr as any).__blackiyaRequestHeaders,
            pageUrl: window.location.href,
            resolveAdapter: getPlatformAdapter,
            cache: conversationResponseCache,
            canMutate: (platformName) =>
                platformName === captureEpoch.platform &&
                isProviderStateEpochCurrent(captureEpoch.platform, captureEpoch.value),
            onNonTerminal: (platformName, conversationId) => {
                if (
                    platformName === captureEpoch.platform &&
                    isProviderStateEpochCurrent(captureEpoch.platform, captureEpoch.value)
                ) {
                    invalidateConversationSnapshot(captureEpoch.platform, conversationId);
                }
            },
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
    captureEpoch: ProviderCaptureEpoch | null,
): void => {
    invalidateCapturedRequestContext(url, xhr.status);
    if (xhr.status < 200 || xhr.status >= 300 || captureXhrProviderResponse(providerPlan, xhr, captureEpoch)) {
        return;
    }
    if (
        !classifyGenerationEndpoint(url, method, window.location.href) &&
        captureEpoch &&
        isProviderStateEpochCurrent(captureEpoch.platform, captureEpoch.value)
    ) {
        captureGenericXhrResponse(xhr, url, method, captureEpoch);
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
    const classification = classifyGenerationEndpoint(url, method, window.location.href);
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
            captureHeaders(
                url,
                toForwardableHeaderRecord((xhr as any).__blackiyaRequestHeaders, resolvePlatformName(url) ?? undefined),
            );
            const classification = classifyGenerationEndpoint(url, method, window.location.href);
            invalidateActiveConversationForGeneration(url, classification);
            invalidateDeterministicDetailRequestStart(url, method);
            const platform = resolvePlatformName(url);
            const captureEpoch = platform ? { platform, value: getProviderStateEpoch(platform) } : null;
            const providerPlan = prepareXhrProviderCapture(url, method, body);
            if (
                providerPlan?.kind === 'meta' &&
                providerPlan.captureContext.requestContext.kind === 'conversation-detail'
            ) {
                conversationResponseCache.delete(
                    'Meta Muse',
                    providerPlan.captureContext.requestContext.conversationId,
                );
            }
            if (providerPlan?.kind === 'zai' && providerPlan.context.method === 'GET') {
                conversationResponseCache.delete('Z.ai', providerPlan.context.conversationId);
            }
            xhr.addEventListener('load', () => handleXhrLoad(xhr, url, method, providerPlan, captureEpoch));

            captureGeminiXhrContext(url, method, body);
            installXhrStreamCapture(xhr, url, method);

            return originalSend.call(this, body);
        };

        setupMainWorldBridge();
    },
});
