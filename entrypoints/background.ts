/**
 * Background Service Worker
 *
 * Handles extension lifecycle events and message passing.
 * Currently minimal as the content script handles most functionality.
 *
 * @module entrypoints/background
 */

import { logger } from '@/utils/logger';
import { logsStorage } from '@/utils/logs-storage';

export default defineBackground(() => {
    const allowedExternalIds = new Set(['pngbgngdjojmnajfgfecpgbhpehmcjfj']);

    logger.info('Background service worker started', {
        id: browser.runtime.id,
    });

    // Listen for installation/update events
    browser.runtime.onInstalled.addListener((details) => {
        if (details.reason === 'install') {
            logger.info('Extension installed');
        } else if (details.reason === 'update') {
            logger.info('Extension updated to version', browser.runtime.getManifest().version);
        }
    });

    // Message handler for future extensibility
    // Currently content script handles everything locally
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // Handle log entries first to avoid re-logging them
        if (message.type === 'LOG_ENTRY') {
            // Check if payload is valid
            if (message.payload) {
                logsStorage.saveLog(message.payload).catch((err) => {
                    console.error('Failed to save log from content script:', err);
                });
            }
            return; // Don't log LOG_ENTRY messages to avoid loops
        }

        logger.info('Received message:', message.type, 'from', sender.tab?.url);

        // Handle different message types
        switch (message.type) {
            case 'PING':
                // Simple ping to check if background is alive
                sendResponse({ success: true, pong: true });
                break;

            default:
                logger.warn('Unknown message type:', message.type);
                sendResponse({ success: false, error: 'Unknown message type' });
        }

        // Return true to indicate async response (even if we respond sync)
        return true;
    });

    browser.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
        if (!sender?.id || !allowedExternalIds.has(sender.id)) {
            sendResponse({ success: false, error: 'UNAUTHORIZED' });
            return;
        }

        (async () => {
            const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
            if (!activeTab?.id) {
                return { success: false, error: 'NO_ACTIVE_TAB' };
            }

            if (message?.type === 'GET_CONVERSATION_JSON') {
                return await browser.tabs.sendMessage(activeTab.id, { type: 'EXTERNAL_GET_CONVERSATION_JSON' });
            }

            if (message?.type === 'TRIGGER_SAVE_JSON') {
                return await browser.tabs.sendMessage(activeTab.id, { type: 'EXTERNAL_TRIGGER_SAVE_JSON' });
            }

            return { success: false, error: 'UNKNOWN_MESSAGE' };
        })()
            .then((response) => sendResponse(response))
            .catch((error) => {
                logger.error('External message handler failed:', error);
                sendResponse({ success: false, error: 'INTERNAL_ERROR' });
            });

        return true;
    });
});
