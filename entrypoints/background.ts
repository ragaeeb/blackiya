/**
 * Background Service Worker
 *
 * Handles extension lifecycle events and message passing.
 * Currently minimal as the content script handles most functionality.
 *
 * @module entrypoints/background
 */

export default defineBackground(() => {
    console.log('[Blackiya] Background service worker started', {
        id: browser.runtime.id,
    });

    // Listen for installation/update events
    browser.runtime.onInstalled.addListener((details) => {
        if (details.reason === 'install') {
            console.log('[Blackiya] Extension installed');
        } else if (details.reason === 'update') {
            console.log('[Blackiya] Extension updated to version', browser.runtime.getManifest().version);
        }
    });

    // Message handler for future extensibility
    // Currently content script handles everything locally
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log('[Blackiya] Received message:', message.type, 'from', sender.tab?.url);

        // Handle different message types
        switch (message.type) {
            case 'PING':
                // Simple ping to check if background is alive
                sendResponse({ success: true, pong: true });
                break;

            default:
                console.log('[Blackiya] Unknown message type:', message.type);
                sendResponse({ success: false, error: 'Unknown message type' });
        }

        // Return true to indicate async response (even if we respond sync)
        return true;
    });
});
