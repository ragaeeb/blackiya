import { browser } from 'wxt/browser';
import { createInterceptorAttemptRegistry } from '@/entrypoints/interceptor/attempt-registry';
import {
    type BootstrapRequestLifecycleDeps,
    cacheGeminiPromptHintFromXhrBody as cacheGeminiPromptHintFromXhrBodyCore,
    cachePromptHintFromGrokRequest as cachePromptHintFromGrokRequestCore,
    emitFetchPromptLifecycle as emitFetchPromptLifecycleCore,
    emitXhrRequestLifecycle as emitXhrRequestLifecycleCore,
    maybeMonitorFetchStreams as maybeMonitorFetchStreamsCore,
    registerXhrLoadHandler as registerXhrLoadHandlerCore,
    shouldEmitNonChatLifecycleForRequest as shouldEmitNonChatLifecycleForRequestCore,
} from '@/entrypoints/interceptor/bootstrap-lifecycle';
import {
    type MainWorldBridgeDeps,
    setupMainWorldBridge as setupMainWorldBridgeCore,
} from '@/entrypoints/interceptor/bootstrap-main-bridge';
import { appendToCaptureQueue, appendToLogQueue, getRawCaptureHistory } from '@/entrypoints/interceptor/capture-queue';
import {
    resolveLifecycleConversationId,
    resolveRequestConversationId,
} from '@/entrypoints/interceptor/conversation-utils';
import { safePathname } from '@/entrypoints/interceptor/discovery';
import { type FetchInterceptionDeps, handleFetchInterception } from '@/entrypoints/interceptor/fetch-interception';
import { createFetchInterceptorContext, type FetchInterceptorContext } from '@/entrypoints/interceptor/fetch-pipeline';
import { createFetchInterceptor } from '@/entrypoints/interceptor/fetch-wrapper';
import { maybeCaptureGeminiBatchexecuteContext } from '@/entrypoints/interceptor/gemini-batchexecute-context-store';
import { resolveHeaderCaptureAdapter } from '@/entrypoints/interceptor/header-capture';
import { createInterceptorEmitter, type InterceptorEmitterState } from '@/entrypoints/interceptor/interceptor-emitter';
import { ProactiveFetchRunner } from '@/entrypoints/interceptor/proactive-fetch-runner';
import { cleanupDisposedAttemptState } from '@/entrypoints/interceptor/state';
import type { StreamMonitorEmitter } from '@/entrypoints/interceptor/stream-monitors/stream-emitter';
import type { XhrInterceptionDeps } from '@/entrypoints/interceptor/xhr-interception';
import { buildXhrLifecycleContext, type XhrLifecycleContext } from '@/entrypoints/interceptor/xhr-pipeline';
import { notifyXhrOpen } from '@/entrypoints/interceptor/xhr-wrapper';
import { chatGPTAdapter } from '@/platforms/chatgpt';
import { SUPPORTED_PLATFORM_URLS } from '@/platforms/constants';
import { getPlatformAdapterByApiUrl, getPlatformAdapterByCompletionUrl } from '@/platforms/factory';
import type { LLMPlatform } from '@/platforms/types';
import { setBoundedMapValue } from '@/utils/bounded-collections';
import { platformHeaderStore } from '@/utils/platform-header-store';
import { extractForwardableHeadersFromFetchArgs, toForwardableHeaderRecord } from '@/utils/proactive-fetch-headers';
import { loadExtensionEnabledSetting, STORAGE_KEYS } from '@/utils/settings';

export { shouldApplySessionInitToken } from '@/entrypoints/interceptor/bootstrap-main-bridge';
export {
    shouldEmitXhrRequestLifecycle,
    tryEmitGeminiXhrLoadendCompletion,
    tryMarkGeminiXhrLoadendCompleted,
} from '@/entrypoints/interceptor/signal-emitter';
export { cleanupDisposedAttemptState, pruneTimestampCache } from '@/entrypoints/interceptor/state';

const completionSignalCache = new Map<string, number>();
const transientLogCache = new Map<string, number>();
const capturePayloadCache = new Map<string, number>();
const lifecycleSignalCache = new Map<string, number>();
const conversationResolvedSignalCache = new Map<string, number>();
const promptHintByAttempt = new Map<string, string>();
const attemptByConversationId = new Map<string, string>();
const latestAttemptIdByPlatform = new Map<string, string>();
const disposedAttemptIds = new Set<string>();

const MAX_INTERCEPTOR_DEDUPE_CACHE_ENTRIES = 300;
const MAX_INTERCEPTOR_ATTEMPT_BINDINGS = 400;
const INTERCEPTOR_CACHE_ENTRY_TTL_MS = 60_000;
const INTERCEPTOR_CACHE_PRUNE_INTERVAL_MS = 15_000;
const INTERCEPTOR_RUNTIME_TAG = 'v2.1.1-grok-stream';

const attemptRegistry = createInterceptorAttemptRegistry({
    state: { attemptByConversationId, latestAttemptIdByPlatform, disposedAttemptIds },
    maxAttemptBindings: MAX_INTERCEPTOR_ATTEMPT_BINDINGS,
    defaultPlatformName: chatGPTAdapter.name,
});

const { bindAttemptToConversation, resolveAttemptIdForConversation, peekAttemptIdForConversation, isAttemptDisposed } =
    attemptRegistry;

const emitterState: InterceptorEmitterState = {
    completionSignalCache,
    transientLogCache,
    capturePayloadCache,
    lifecycleSignalCache,
    conversationResolvedSignalCache,
    promptHintByAttempt,
    lastCachePruneAtMs: 0,
};

const emitter = createInterceptorEmitter({
    state: emitterState,
    maxDedupeEntries: MAX_INTERCEPTOR_DEDUPE_CACHE_ENTRIES,
    cacheTtlMs: INTERCEPTOR_CACHE_ENTRY_TTL_MS,
    cachePruneIntervalMs: INTERCEPTOR_CACHE_PRUNE_INTERVAL_MS,
    defaultPlatformName: chatGPTAdapter.name,
    resolveAttemptIdForConversation,
    bindAttemptToConversation,
    isAttemptDisposed,
    appendToLogQueue,
    appendToCaptureQueue,
});

const cleanupDisposedAttempt = (attemptId: string) => {
    cleanupDisposedAttemptState(attemptId, {
        disposedAttemptIds,
        promptHintByAttempt,
        latestAttemptIdByPlatform,
        attemptByConversationId,
    });
};

const buildMainWorldBridgeDeps = (): MainWorldBridgeDeps => ({
    getRawCaptureHistory,
    cleanupDisposedAttempt,
});

const buildRequestLifecycleDeps = (): BootstrapRequestLifecycleDeps => ({
    emitter,
    resolveAttemptIdForConversation,
    bindAttemptToConversation,
    latestAttemptIdByPlatform,
    disposedAttemptIds,
    maxAttemptBindings: MAX_INTERCEPTOR_ATTEMPT_BINDINGS,
    safePathname,
});

const shouldEmitNonChatLifecycleForRequest = (adapter: LLMPlatform, url: string) =>
    shouldEmitNonChatLifecycleForRequestCore(adapter, url, buildRequestLifecycleDeps());

const emitFetchPromptLifecycle = (context: FetchInterceptorContext) =>
    emitFetchPromptLifecycleCore(context, buildRequestLifecycleDeps());

const cachePromptHintFromGrokRequest = (context: FetchInterceptorContext) =>
    cachePromptHintFromGrokRequestCore(context, buildRequestLifecycleDeps());

const maybeMonitorFetchStreams = (context: FetchInterceptorContext, response: Response, emit: StreamMonitorEmitter) =>
    maybeMonitorFetchStreamsCore(context, response, emit, buildRequestLifecycleDeps());

const cacheGeminiPromptHintFromXhrBody = (context: XhrLifecycleContext, body: unknown) =>
    cacheGeminiPromptHintFromXhrBodyCore(context, body, buildRequestLifecycleDeps());

const emitXhrRequestLifecycle = (xhr: XMLHttpRequest, context: XhrLifecycleContext, emit: StreamMonitorEmitter) =>
    emitXhrRequestLifecycleCore(xhr, context, emit, buildRequestLifecycleDeps());

const registerXhrLoadHandler = (xhr: XMLHttpRequest, methodUpper: string, deps: XhrInterceptionDeps) =>
    registerXhrLoadHandlerCore(xhr, methodUpper, deps);

const maybeCaptureGeminiContextFromFetchArgs = async (
    args: Parameters<typeof fetch>,
    outgoingMethod: string,
    outgoingUrl: string,
) => {
    if (outgoingMethod !== 'POST') {
        return;
    }
    let requestBody: unknown = args[1]?.body;
    if (requestBody === undefined && args[0] instanceof Request) {
        try {
            requestBody = await args[0].clone().text();
        } catch {
            requestBody = undefined;
        }
    }
    maybeCaptureGeminiBatchexecuteContext(outgoingUrl, requestBody);
};

export const registerExtensionEnabledStorageListener = (
    storage: Pick<typeof browser.storage, 'onChanged'> | undefined,
    listener: Parameters<NonNullable<typeof browser.storage.onChanged>['addListener']>[0],
) => {
    storage?.onChanged?.addListener?.(listener);
};

export default defineContentScript({
    matches: [...SUPPORTED_PLATFORM_URLS],
    world: 'MAIN',
    runAt: 'document_start',
    async main() {
        let extensionEnabled = await loadExtensionEnabledSetting();
        if (!extensionEnabled) {
            return;
        }
        if ((window as any).__BLACKIYA_INTERCEPTED__) {
            emitter.log('info', 'already init (skip duplicate interceptor bootstrap)');
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

        const originalFetch = window.fetch.bind(window);
        const storageChangeListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
            if (areaName !== 'local') {
                return;
            }
            if (changes[STORAGE_KEYS.EXTENSION_ENABLED]) {
                extensionEnabled = changes[STORAGE_KEYS.EXTENSION_ENABLED]?.newValue !== false;
            }
        };
        registerExtensionEnabledStorageListener(browser?.storage, storageChangeListener as any);

        const proactiveFetchRunner = new ProactiveFetchRunner(
            originalFetch,
            resolveAttemptIdForConversation,
            emitter,
            MAX_INTERCEPTOR_DEDUPE_CACHE_ENTRIES,
        );
        const streamMonitorEmitter = emitter.createStreamMonitorEmitter();

        const fetchInterceptionDeps: FetchInterceptionDeps = {
            emitter,
            resolveAttemptIdForConversation,
            isExtensionEnabled: () => extensionEnabled,
        };

        const interceptFetchRequest = async (args: Parameters<typeof fetch>): Promise<Response> => {
            if (!extensionEnabled) {
                return originalFetch(...args);
            }
            const context = createFetchInterceptorContext(args, {
                getRequestUrl: (req) => (req instanceof Request ? req.url : String(req)),
                getRequestMethod: (callArgs) =>
                    callArgs[1]?.method || (callArgs[0] instanceof Request ? callArgs[0].method : 'GET'),
                getPlatformAdapterByApiUrl,
                chatGptPlatformName: chatGPTAdapter.name,
                shouldEmitNonChatLifecycleForRequest,
                resolveRequestConversationId,
                peekAttemptIdForConversation,
                resolveAttemptIdForConversation,
                resolveLifecycleConversationId,
                safePathname,
            });
            if (!extensionEnabled) {
                return originalFetch(...args);
            }
            await cachePromptHintFromGrokRequest(context);
            emitFetchPromptLifecycle(context);
            await maybeCaptureGeminiContextFromFetchArgs(args, context.outgoingMethod, context.outgoingUrl);

            const response = await originalFetch(...args);
            if (!extensionEnabled) {
                return response;
            }
            maybeMonitorFetchStreams(context, response, streamMonitorEmitter);

            const url = args[0] instanceof Request ? args[0].url : String(args[0]);
            const apiAdapter = getPlatformAdapterByApiUrl(url);
            const completionAdapter = getPlatformAdapterByCompletionUrl(url);
            const matchedAdapter = resolveHeaderCaptureAdapter(context.fetchApiAdapter, apiAdapter, completionAdapter);
            const forwardableHeaders = extractForwardableHeadersFromFetchArgs(args);
            if (matchedAdapter && forwardableHeaders) {
                platformHeaderStore.update(matchedAdapter.name, forwardableHeaders);
            }
            if (completionAdapter) {
                void proactiveFetchRunner.trigger(completionAdapter, url, forwardableHeaders);
            }

            handleFetchInterception(args, response, fetchInterceptionDeps);
            return response;
        };

        window.fetch = createFetchInterceptor(originalFetch, async (input, init) =>
            interceptFetchRequest([input, init] as Parameters<typeof fetch>),
        );

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

        const xhrInterceptionDeps: XhrInterceptionDeps = {
            emitter,
            resolveAttemptIdForConversation,
            proactiveFetchRunner,
            isExtensionEnabled: () => extensionEnabled,
        };

        XHR.prototype.send = function (body?: any) {
            if (!extensionEnabled) {
                return originalSend.call(this, body);
            }
            const xhr = this as XMLHttpRequest;
            const context = buildXhrLifecycleContext(xhr, {
                getPlatformAdapterByApiUrl,
                chatGptPlatformName: chatGPTAdapter.name,
                shouldEmitNonChatLifecycleForRequest,
                resolveRequestConversationId,
                peekAttemptIdForConversation,
            });
            if (!extensionEnabled) {
                return originalSend.call(this, body);
            }
            const xhrHeaderAdapter = resolveHeaderCaptureAdapter(
                context.requestAdapter,
                getPlatformAdapterByApiUrl(context.requestUrl),
                getPlatformAdapterByCompletionUrl(context.requestUrl),
            );
            if (xhrHeaderAdapter) {
                const xhrHeaders = toForwardableHeaderRecord((xhr as any)._headers);
                if (xhrHeaders) {
                    platformHeaderStore.update(xhrHeaderAdapter.name, xhrHeaders);
                }
            }
            cacheGeminiPromptHintFromXhrBody(context, body);
            if (context.methodUpper === 'POST') {
                maybeCaptureGeminiBatchexecuteContext(context.requestUrl, body);
            }
            emitXhrRequestLifecycle(xhr, context, streamMonitorEmitter);
            registerXhrLoadHandler(xhr, context.methodUpper, xhrInterceptionDeps);
            return originalSend.call(this, body);
        };

        emitter.log('info', 'init', { host: window.location.hostname, runtimeTag: INTERCEPTOR_RUNTIME_TAG });
        setupMainWorldBridgeCore(buildMainWorldBridgeDeps());
    },
});

export { setBoundedMapValue };
