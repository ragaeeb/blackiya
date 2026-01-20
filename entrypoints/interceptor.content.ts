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
        '*',
    );
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
                        window.postMessage(
                            {
                                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                                url,
                                data: text,
                                platform: adapter.name,
                            },
                            window.location.origin,
                        );
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
                        window.postMessage(
                            {
                                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                                url,
                                data: responseText,
                                platform: adapter.name,
                            },
                            window.location.origin,
                        );
                    } catch (e) {
                        log('error', '[Blackiya] Failed to read XHR response', e);
                    }
                }
            });
            return originalSend.call(this, body);
        };

        log('info', '[Blackiya] Fetch & XHR interceptors initialized');
    },
});
