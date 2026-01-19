export default defineContentScript({
    matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    world: 'MAIN',
    runAt: 'document_start',
    main() {
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
            const response = await originalFetch(...args);
            const url = args[0] instanceof Request ? args[0].url : String(args[0]);

            if (url.includes('/backend-api/conversation/')) {
                const clonedResponse = response.clone();
                clonedResponse
                    .json()
                    .then((data) => {
                        window.postMessage(
                            {
                                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                                url,
                                data,
                            },
                            '*',
                        );
                    })
                    .catch((err) => {
                        console.error('[Blackiya] Failed to parse intercepted JSON:', err);
                    });
            }
            return response;
        };
        console.log('[Blackiya] Fetch interceptor initialized');
    },
});
