import { SUPPORTED_PLATFORM_URLS } from '@/platforms/constants';
import { getPlatformAdapterByApiUrl } from '@/platforms/factory';

function log(level: 'info' | 'warn' | 'error', message: string, ...args: any[]) {
    // Keep console output for immediate debugging in the page console
    if (level === 'error') {
        console.error(message, ...args);
    } else if (level === 'warn') {
        console.warn(message, ...args);
    } else {
        console.log(message, ...args);
    }

    // Send to content script for persistence
    window.postMessage(
        {
            type: 'LLM_LOG_ENTRY',
            payload: {
                level,
                message,
                data: args,
                context: 'interceptor',
            },
        },
        window.location.origin,
    );
}

function queueInterceptedMessage(payload: { type: string; url: string; data: string; platform: string }) {
    const queue = ((window as any).__BLACKIYA_CAPTURE_QUEUE__ as (typeof payload)[] | undefined) ?? [];
    queue.push(payload);
    // Prevent unbounded growth if the content script initializes late
    if (queue.length > 50) {
        queue.splice(0, queue.length - 50);
    }
    (window as any).__BLACKIYA_CAPTURE_QUEUE__ = queue;
}

export default defineContentScript({
    matches: [...SUPPORTED_PLATFORM_URLS],
    world: 'MAIN',
    runAt: 'document_start',
    main() {
        // Idempotency: prevent double-injection if the extension is reloaded or content script runs twice
        if ((window as any).__BLACKIYA_INTERCEPTED__) {
            log('warn', '[Blackiya] Interceptor already initialized, skipping reinjection.');
            return;
        }
        (window as any).__BLACKIYA_INTERCEPTED__ = true;

        // Store originals for cleanup/restore
        if (!(window as any).__BLACKIYA_ORIGINALS__) {
            (window as any).__BLACKIYA_ORIGINALS__ = {
                fetch: window.fetch,
                XMLHttpRequestOpen: XMLHttpRequest.prototype.open,
                XMLHttpRequestSend: XMLHttpRequest.prototype.send,
            };
        }

        const originalFetch = window.fetch;

        window.fetch = (async (...args: Parameters<typeof fetch>) => {
            const response = await originalFetch(...args);
            const url = args[0] instanceof Request ? args[0].url : String(args[0]);

            const adapter = getPlatformAdapterByApiUrl(url);
            log('info', `[Blackiya] Intercepted fetch: ${url}, Adapter: ${adapter?.name || 'None'}`);

            if (adapter) {
                const clonedResponse = response.clone();
                clonedResponse
                    .text()
                    .then((text) => {
                        const payload = {
                            type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                            url,
                            data: text,
                            platform: adapter.name,
                        };
                        queueInterceptedMessage(payload);
                        window.postMessage(payload, window.location.origin);
                    })
                    .catch((err) => {
                        log('error', `[Blackiya] Failed to read intercepted response from ${adapter.name}:`, err);
                    });
            }

            return response;
        }) as any;

        // XHR Interceptor
        const XHR = window.XMLHttpRequest;
        const originalOpen = XHR.prototype.open;
        const originalSend = XHR.prototype.send;

        XHR.prototype.open = function (_method: string, url: string | URL, ...args: any[]) {
            (this as any)._url = String(url);
            return originalOpen.apply(this, [_method, url, ...args] as any);
        };

        XHR.prototype.send = function (body?: any) {
            this.addEventListener('load', function () {
                const url = (this as any)._url;
                const adapter = getPlatformAdapterByApiUrl(url);
                log('info', `[Blackiya] Intercepted XHR: ${url}, Adapter: ${adapter?.name || 'None'}`);

                if (adapter) {
                    try {
                        const responseText = this.responseText;
                        const payload = {
                            type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                            url,
                            data: responseText,
                            platform: adapter.name,
                        };
                        queueInterceptedMessage(payload);
                        window.postMessage(payload, window.location.origin);
                    } catch (e) {
                        log('error', '[Blackiya] Failed to read XHR response', e);
                    }
                }
            });
            return originalSend.call(this, body);
        };

        log('info', '[Blackiya] Fetch & XHR interceptors initialized');

        if (!(window as any).__blackiya) {
            const REQUEST_TYPE = 'BLACKIYA_GET_JSON_REQUEST';
            const RESPONSE_TYPE = 'BLACKIYA_GET_JSON_RESPONSE';
            const timeoutMs = 5000;

            const makeRequestId = () => {
                if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
                    return crypto.randomUUID();
                }
                return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            };

            (window as any).__blackiya = {
                getJSON: () =>
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
                            if (event.source !== window || event.origin !== window.location.origin) {
                                return;
                            }
                            const message = event.data;
                            if (message?.type !== RESPONSE_TYPE || message.requestId !== requestId) {
                                return;
                            }
                            cleanup();
                            if (message.success) {
                                resolve(message.data);
                            } else {
                                reject(new Error(message.error || 'FAILED'));
                            }
                        };

                        window.addEventListener('message', handler);
                        window.postMessage({ type: REQUEST_TYPE, requestId }, window.location.origin);

                        timeoutId = window.setTimeout(() => {
                            cleanup();
                            reject(new Error('TIMEOUT'));
                        }, timeoutMs);
                    }),
            };
        }
    },
});
