import { getPlatformAdapterByApiUrl } from '@/platforms/factory';

export default defineContentScript({
    matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://gemini.google.com/*'],
    world: 'MAIN',
    runAt: 'document_start',
    main() {
        const originalFetch = window.fetch;

        window.fetch = (async (...args: Parameters<typeof fetch>) => {
            const response = await originalFetch(...args);
            const url = args[0] instanceof Request ? args[0].url : String(args[0]);

            const adapter = getPlatformAdapterByApiUrl(url);
            console.log(`[Blackiya] Intercepted fetch: ${url}, Adapter: ${adapter?.name || 'None'}`);

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
                            '*',
                        );
                    })
                    .catch((err) => {
                        console.error(`[Blackiya] Failed to read intercepted response from ${adapter.name}:`, err);
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
                console.log(`[Blackiya] Intercepted XHR: ${url}, Adapter: ${adapter?.name || 'None'}`);

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
                            '*',
                        );
                    } catch (e) {
                        console.error('[Blackiya] Failed to read XHR response', e);
                    }
                }
            });
            return originalSend.call(this, body);
        };

        console.log('[Blackiya] Fetch & XHR interceptors initialized');
    },
});
