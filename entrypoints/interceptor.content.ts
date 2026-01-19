import { getPlatformAdapterByApiUrl } from '../platforms/factory';

export default defineContentScript({
    matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://gemini.google.com/*'],
    world: 'MAIN',
    runAt: 'document_start',
    main() {
        const originalFetch = window.fetch;

        window.fetch = (async (...args: Parameters<typeof fetch>) => {
            const response = await originalFetch(...args);
            const url = args[0] instanceof Request ? args[0].url : String(args[0]);

            // Match single conversation endpoint, not list or other endpoints
            if (/\/backend-api\/conversation\/[a-f0-9-]+$/.test(url)) {
                // Also match Gemini batchexecute with hNvQHb
            } else if (url.includes('/_/BardChatUi/data/batchexecute') && url.includes('rpcids=hNvQHb')) {
                // Should fall through to adapter check below, or we can check here
            }

            const adapter = getPlatformAdapterByApiUrl(url);

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
        console.log('[Blackiya] Fetch interceptor initialized for multiple platforms');
    },
});
