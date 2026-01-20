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

import { getPlatformAdapter } from '@/platforms/factory';
import type { LLMPlatform } from '@/platforms/types';
import { downloadAsJSON } from '@/utils/download';
import { logger } from '@/utils/logger';
import { InterceptionManager } from '@/utils/managers/interception-manager';
import { NavigationManager } from '@/utils/managers/navigation-manager';
import { ButtonManager } from '@/utils/ui/button-manager';

export function runPlatform(): void {
    let currentAdapter: LLMPlatform | null = null;
    let currentConversationId: string | null = null;

    // -- Manager Initialization --

    // 1. UI Manager
    const buttonManager = new ButtonManager(handleSaveClick);

    // 2. Data Manager
    const interceptionManager = new InterceptionManager((capturedId) => {
        // Callback when data is captured
        const currentId = currentAdapter?.extractConversationId(window.location.href);
        if (currentId && currentId === capturedId && buttonManager.exists()) {
            buttonManager.setOpacity('1');
        }
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

        const conversationId = currentAdapter.extractConversationId(window.location.href);
        if (!conversationId) {
            logger.error('No conversation ID found in URL');
            alert('Please select a conversation first.');
            return;
        }

        const data = interceptionManager.getConversation(conversationId);
        if (!data) {
            logger.warn('No data captured for this conversation yet.');
            alert('Conversation data not yet captured. Please refresh the page or wait for the conversation to load.');
            return;
        }

        buttonManager.setLoading(true);
        try {
            const filename = currentAdapter.formatFilename(data);
            downloadAsJSON(data, filename);
            logger.info(`Saved conversation: ${filename}.json`);
        } catch (error) {
            logger.error('Failed to save conversation:', error);
            alert('Failed to save conversation. Check console for details.');
        } finally {
            buttonManager.setLoading(false);
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

        // Check if we already have data
        const hasData = interceptionManager.getConversation(conversationId);
        if (hasData) {
            buttonManager.setOpacity('1');
        } else {
            buttonManager.setOpacity('0.6');
        }
    }

    function handleNavigationChange(): void {
        if (!currentAdapter) {
            return;
        }

        const newConversationId = currentAdapter.extractConversationId(window.location.href);
        if (newConversationId !== currentConversationId) {
            buttonManager.remove();
            if (newConversationId) {
                // Determine if we need to update adapter (e.g. cross-platform nav? likely not in same tab but good practice)
                const newAdapter = getPlatformAdapter(window.location.href);
                if (newAdapter && newAdapter.name !== currentAdapter.name) {
                    currentAdapter = newAdapter;
                    updateManagers();
                }

                setTimeout(injectSaveButton, 500);
            }
        } else {
            // ID hasn't changed, but maybe DOM has (re-render), ensure button exists
            if (newConversationId && !buttonManager.exists()) {
                setTimeout(injectSaveButton, 500);
            }
        }
    }

    function updateManagers(): void {
        interceptionManager.updateAdapter(currentAdapter);
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
