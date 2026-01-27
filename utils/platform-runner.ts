/**
 * Platform Runner Utility
 *
 * Orchestrator that ties together the specialized managers for:
 * - UI (ButtonManager)
 * - Data (InterceptionManager)
 * - Navigation (NavigationManager)
 *
 * @module utils/platform-runner
 */

import { browser } from 'wxt/browser';
import { getPlatformAdapter } from '@/platforms/factory';
import type { LLMPlatform } from '@/platforms/types';
import { downloadAsJSON } from '@/utils/download';
import { logger } from '@/utils/logger';
import { InterceptionManager } from '@/utils/managers/interception-manager';
import { NavigationManager } from '@/utils/managers/navigation-manager';
import type { ConversationData } from '@/utils/types';
import { ButtonManager } from '@/utils/ui/button-manager';

export function runPlatform(): void {
    let currentAdapter: LLMPlatform | null = null;
    let currentConversationId: string | null = null;

    // -- Manager Initialization --

    // 1. UI Manager
    const buttonManager = new ButtonManager(handleSaveClick, handleCopyClick);

    // 2. Data Manager
    const interceptionManager = new InterceptionManager((_capturedId) => {
        refreshButtonState();
    });

    // 3. Navigation Manager
    const navigationManager = new NavigationManager(() => {
        handleNavigationChange();
    });

    /**
     * Core orchestrator logic functions
     */

    async function handleSaveClick(): Promise<void> {
        if (!currentAdapter) {
            return;
        }
        const data = await getConversationData();
        if (!data) {
            return;
        }
        await saveConversation(data, 'ui');
    }

    async function handleCopyClick(): Promise<void> {
        if (!currentAdapter) {
            return;
        }
        const data = await getConversationData();
        if (!data) {
            return;
        }

        try {
            await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
            logger.info('Copied conversation to clipboard');
            buttonManager.setSuccess('copy');
        } catch (error) {
            handleError('copy', error);
            buttonManager.setLoading(false, 'copy');
        }
    }

    async function getConversationData(options: { silent?: boolean } = {}) {
        if (!currentAdapter) {
            return null;
        }

        const conversationId = currentAdapter.extractConversationId(window.location.href);
        if (!conversationId) {
            logger.error('No conversation ID found in URL');
            if (!options.silent) {
                alert('Please select a conversation first.');
            }
            return null;
        }

        const data = interceptionManager.getConversation(conversationId);
        if (!data) {
            logger.warn('No data captured for this conversation yet.');
            if (!options.silent) {
                alert(
                    'Conversation data not yet captured. Please refresh the page or wait for the conversation to load.',
                );
            }
            return null;
        }
        return data;
    }

    function handleError(action: 'save' | 'copy', error: unknown, silent?: boolean) {
        logger.error(`Failed to ${action} conversation:`, error);
        if (!silent) {
            alert(`Failed to ${action} conversation. Check console for details.`);
        }
    }

    async function saveConversation(data: ConversationData, source: 'ui' | 'external'): Promise<boolean> {
        if (!currentAdapter) {
            return false;
        }

        if (buttonManager.exists()) {
            buttonManager.setLoading(true, 'save');
        }

        try {
            const filename = currentAdapter.formatFilename(data);
            downloadAsJSON(data, filename);
            logger.info(`Saved conversation: ${filename}.json`);
            if (buttonManager.exists()) {
                buttonManager.setSuccess('save');
            }
            return true;
        } catch (error) {
            handleError('save', error, source === 'external');
            if (buttonManager.exists()) {
                buttonManager.setLoading(false, 'save');
            }
            return false;
        }
    }

    function injectSaveButton(): void {
        const conversationId = currentAdapter?.extractConversationId(window.location.href) || null;
        if (!conversationId) {
            logger.debug('No conversation ID found. Button will not be injected.');
            buttonManager.remove();
            return;
        }

        const target = currentAdapter?.getButtonInjectionTarget();
        if (!target) {
            logger.debug('Injection target not found, will retry...');
            return;
        }

        buttonManager.inject(target, conversationId);
        currentConversationId = conversationId;

        refreshButtonState(conversationId);
        scheduleButtonRefresh(conversationId);
    }

    function handleNavigationChange(): void {
        if (!currentAdapter) {
            return;
        }

        const newConversationId = currentAdapter.extractConversationId(window.location.href);

        if (newConversationId !== currentConversationId) {
            handleConversationSwitch(newConversationId);
        } else {
            // ID hasn't changed, but maybe DOM has (re-render), ensure button exists
            if (newConversationId && !buttonManager.exists()) {
                setTimeout(injectSaveButton, 500);
            } else {
                refreshButtonState(newConversationId || undefined);
            }
        }
    }

    function handleConversationSwitch(newId: string | null): void {
        buttonManager.remove();
        if (!newId) {
            return;
        }

        // Determine if we need to update adapter (e.g. cross-platform nav? likely not in same tab but good practice)
        const newAdapter = getPlatformAdapter(window.location.href);
        if (newAdapter && currentAdapter && newAdapter.name !== currentAdapter.name) {
            currentAdapter = newAdapter;
            updateManagers();
        }

        setTimeout(injectSaveButton, 500);
    }

    function updateManagers(): void {
        interceptionManager.updateAdapter(currentAdapter);
    }

    function refreshButtonState(forConversationId?: string): void {
        if (!buttonManager.exists() || !currentAdapter) {
            return;
        }
        const conversationId = forConversationId || currentAdapter.extractConversationId(window.location.href);
        if (!conversationId) {
            return;
        }
        const hasData = interceptionManager.getConversation(conversationId);
        buttonManager.setOpacity(hasData ? '1' : '0.6');
    }

    function scheduleButtonRefresh(conversationId: string): void {
        let attempts = 0;
        const maxAttempts = 6;
        const intervalMs = 500;

        const tick = () => {
            attempts += 1;
            if (!buttonManager.exists()) {
                return;
            }
            const hasData = interceptionManager.getConversation(conversationId);
            if (hasData) {
                buttonManager.setOpacity('1');
                return;
            }
            if (attempts < maxAttempts) {
                setTimeout(tick, intervalMs);
            }
        };

        setTimeout(tick, intervalMs);
    }

    function registerExternalListener(): void {
        browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (message?.type === 'EXTERNAL_GET_CONVERSATION_JSON') {
                getConversationData({ silent: true })
                    .then((data) => {
                        if (!data) {
                            sendResponse({ success: false, error: 'NO_CONVERSATION_DATA' });
                            return;
                        }
                        sendResponse({ success: true, data });
                    })
                    .catch((error) => {
                        logger.error('Failed to handle external get request:', error);
                        sendResponse({ success: false, error: 'INTERNAL_ERROR' });
                    });
                return true;
            }

            if (message?.type === 'EXTERNAL_TRIGGER_SAVE_JSON') {
                getConversationData({ silent: true })
                    .then(async (data) => {
                        if (!data) {
                            sendResponse({ success: false, error: 'NO_CONVERSATION_DATA' });
                            return;
                        }
                        const success = await saveConversation(data, 'external');
                        sendResponse({ success });
                    })
                    .catch((error) => {
                        logger.error('Failed to handle external save request:', error);
                        sendResponse({ success: false, error: 'INTERNAL_ERROR' });
                    });
                return true;
            }

            return false;
        });
    }

    // -- Boot Sequence --

    const url = window.location.href;
    currentAdapter = getPlatformAdapter(url);

    if (!currentAdapter) {
        logger.warn('No matching platform adapter for this URL');
        return;
    }

    logger.info(`Content script running for ${currentAdapter.name}`);

    // Update managers with initial adapter
    updateManagers();

    // Start listening
    interceptionManager.start();
    navigationManager.start();
    registerExternalListener();

    // Initial injection
    currentConversationId = currentAdapter.extractConversationId(url);
    injectSaveButton();

    // Retry logic for initial load (sometimes SPA takes time to render header)
    const retryIntervals = [1000, 2000, 5000];
    for (const delay of retryIntervals) {
        setTimeout(() => {
            if (!buttonManager.exists()) {
                injectSaveButton();
            }
        }, delay);
    }

    // Cleanup on unload
    window.addEventListener('beforeunload', () => {
        try {
            interceptionManager.stop();
            navigationManager.stop();
            buttonManager.remove();
        } catch (error) {
            logger.debug('Error during cleanup:', error);
        }
    });
}
