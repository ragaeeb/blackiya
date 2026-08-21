import { classifyGenerationEndpoint, type GenerationEndpoint } from '@/features/stream-debug/generation-endpoint';
import { monitorFetchResponse } from '@/features/stream-debug/stream-monitor';
import { streamDebugRecorder } from '@/features/stream-debug/recorder';
import { createXhrStreamCapture } from '@/features/stream-debug/xhr-monitor';
import { setupMainWorldBridge } from '@/entrypoints/interceptor/bootstrap-main-bridge';
import { createFetchInterceptor } from '@/entrypoints/interceptor/fetch-wrapper';
import {
    maybeCaptureGeminiBatchexecuteContext,
    resetGeminiBatchexecuteContext,
} from '@/entrypoints/interceptor/gemini-batchexecute-context-store';
import { SUPPORTED_PLATFORM_URLS } from '@/platforms/constants';
import { platformHeaderStore } from '@/utils/platform-header-store';
import {
    extractForwardableHeadersFromFetchArgs,
    type SupportedPlatformName,
    toForwardableHeaderRecord,
} from '@/utils/proactive-fetch-headers';

const INTERCEPTOR_MARKER = '__BLACKIYA_INTERCEPTED__';
const GEMINI_BATCHEXECUTE_PATH = '/_/bardchatui/data/batchexecute';

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
        if (hostname === 'grok.com' || hostname === 'www.grok.com' || hostname === 'grok.x.com') {
            return 'Grok';
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
    if (platform === 'ChatGPT') {
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
        const interceptFetch = async (args: Parameters<typeof fetch>): Promise<Response> => {
            const url = extractRequestUrl(args[0]);
            const method = extractRequestMethod(args[0], args[1]);
            await captureFetchRequestContext(args, url, method);

            const classification = classifyGenerationEndpoint(url, method);
            const streamId = startFetchStreamCapture(classification, method, url);

            let response: Response;
            try {
                response = await originalFetch(...args);
            } catch (error) {
                if (streamId) {
                    streamDebugRecorder.terminateStream(streamId, 'error');
                }
                throw error;
            }

            invalidateCapturedRequestContext(url, response.status);

            if (!classification || !streamId) {
                return response;
            }

            monitorFetchStream(response, streamId, classification);
            return response;
        };

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
            captureHeaders(requestUrl, toForwardableHeaderRecord(headers, resolvePlatformName(requestUrl) ?? undefined));
            return originalSetRequestHeader.call(this, name, value);
        };

        xhrPrototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
            const xhr = this as XMLHttpRequest;
            const url = String((xhr as any).__blackiyaRequestUrl ?? '');
            const method = String((xhr as any).__blackiyaRequestMethod ?? 'GET').toUpperCase();
            xhr.addEventListener('load', () => {
                invalidateCapturedRequestContext(url, xhr.status);
            });
            captureHeaders(
                url,
                toForwardableHeaderRecord(
                    (xhr as any).__blackiyaRequestHeaders,
                    resolvePlatformName(url) ?? undefined,
                ),
            );

            if (isGeminiBatchexecutePost(url, method)) {
                try {
                    maybeCaptureGeminiBatchexecuteContext(url, body);
                } catch {
                    // Safe non-interference boundary.
                }
            }

            const classification = classifyGenerationEndpoint(url, method);
            if (classification) {
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
            }

            return originalSend.call(this, body);
        };

        setupMainWorldBridge();
    },
});
