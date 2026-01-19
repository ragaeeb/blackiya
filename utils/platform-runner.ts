/**
 * Platform Runner Utility
 *
 * Provides a unified logic for all platform content scripts.
 * Handles button injection, navigation observation, and data capture.
 *
 * @module utils/platform-runner
 */

import { getPlatformAdapter } from '@/platforms/factory';
import type { LLMPlatform } from '@/platforms/types';
import { downloadAsJSON } from '@/utils/download';
import type { ConversationData } from '@/utils/types';

export function runPlatform(): void {
    let currentAdapter: LLMPlatform | null = null;
    let saveButton: HTMLButtonElement | null = null;
    let navigationObserver: MutationObserver | null = null;
    let currentConversationId: string | null = null;

    /**
     * Store for captured conversation data
     * maps conversationId -> data
     */
    const capturedConversations = new Map<string, ConversationData>();
    const MAX_CACHED_CONVERSATIONS = 10;

    function cacheConversation(id: string, data: ConversationData): void {
        if (!capturedConversations.has(id) && capturedConversations.size >= MAX_CACHED_CONVERSATIONS) {
            const oldestKey = capturedConversations.keys().next().value;
            if (oldestKey) {
                capturedConversations.delete(oldestKey);
            }
        }
        capturedConversations.set(id, data);
    }

    const BUTTON_STYLES = `
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        margin-left: 8px;
        border: none;
        border-radius: 8px;
        background: linear-gradient(135deg, #10a37f 0%, #0d8a6a 100%);
        color: white;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        box-shadow: 0 2px 4px rgba(16, 163, 127, 0.2);
        z-index: 9999;
    `;

    const BUTTON_HOVER_STYLES = `
        background: linear-gradient(135deg, #0d8a6a 0%, #0a7359 100%);
        box-shadow: 0 4px 8px rgba(16, 163, 127, 0.3);
        transform: translateY(-1px);
    `;

    const BUTTON_LOADING_STYLES = `
        opacity: 0.7;
        cursor: wait;
    `;

    const FIXED_STYLES = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 10000;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    `;

    let isFixedPosition = false;

    function updateButtonStyles(state: 'default' | 'hover' | 'loading'): void {
        if (!saveButton) {
            return;
        }

        let css = BUTTON_STYLES;
        if (state === 'hover') {
            css += BUTTON_HOVER_STYLES;
        } else if (state === 'loading') {
            css += BUTTON_LOADING_STYLES;
        }

        if (isFixedPosition) {
            css += FIXED_STYLES;
        }

        saveButton.style.cssText = css;
    }

    function createSaveButton(): HTMLButtonElement {
        const button = document.createElement('button');
        button.id = 'llm-capture-save-btn';
        button.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Save JSON
        `;

        // Initial style
        button.style.cssText = BUTTON_STYLES;

        button.addEventListener('mouseenter', () => {
            if (!button.disabled) {
                updateButtonStyles('hover');
            }
        });

        button.addEventListener('mouseleave', () => {
            if (!button.disabled) {
                updateButtonStyles('default');
            }
        });

        button.addEventListener('click', handleSaveClick);

        const conversationId = currentAdapter?.extractConversationId(window.location.href);
        if (conversationId && !capturedConversations.has(conversationId)) {
            button.style.opacity = '0.6';
        }

        return button;
    }

    function setButtonLoading(loading: boolean): void {
        if (!saveButton) {
            return;
        }

        saveButton.disabled = loading;
        if (loading) {
            saveButton.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation: spin 1s linear infinite;">
                    <circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="8"/>
                </svg>
                Saving...
            `;
            updateButtonStyles('loading');
        } else {
            saveButton.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Save JSON
            `;
            updateButtonStyles('default');
        }
    }

    async function handleSaveClick(): Promise<void> {
        if (!currentAdapter) {
            return;
        }

        const conversationId = currentAdapter.extractConversationId(window.location.href);
        if (!conversationId) {
            console.error('[Blackiya] No conversation ID found in URL');
            alert('Please select a conversation first.');
            return;
        }

        const data = capturedConversations.get(conversationId);
        if (!data) {
            console.warn('[Blackiya] No data captured for this conversation yet.');
            alert('Conversation data not yet captured. Please refresh the page or wait for the conversation to load.');
            return;
        }

        setButtonLoading(true);
        try {
            const filename = currentAdapter.formatFilename(data);
            downloadAsJSON(data, filename);
            console.log(`[Blackiya] Saved conversation: ${filename}.json`);
        } catch (error) {
            console.error('[Blackiya] Failed to save conversation:', error);
            alert('Failed to save conversation. Check console for details.');
        } finally {
            setButtonLoading(false);
        }
    }

    function setupInterceptorListener(): void {
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Event handler logic requires nested checks
        window.addEventListener('message', (event) => {
            if (event.source !== window) {
                return;
            }

            const message = event.data;
            if (message?.type === 'LLM_CAPTURE_DATA_INTERCEPTED' && message.data) {
                console.log('[Blackiya] Received intercepted data message');
                if (!currentAdapter) {
                    console.warn('[Blackiya] No currentAdapter in runner, ignoring message');
                    return;
                }

                const data = currentAdapter.parseInterceptedData(message.data, message.url);
                if (data?.conversation_id) {
                    const conversationId = data.conversation_id;
                    cacheConversation(conversationId, data);
                    console.log(`[Blackiya] Successfully captured/cached data for conversation: ${conversationId}`);

                    const currentId = currentAdapter.extractConversationId(window.location.href);
                    console.log(`[Blackiya] Current URL ID: ${currentId}, Captured ID: ${conversationId}`);

                    if (currentId === conversationId && saveButton) {
                        saveButton.style.opacity = '1';
                    }
                } else {
                    console.warn('[Blackiya] Failed to parse conversation ID from intercepted data');
                }
            }
        });
    }

    function injectSaveButton(): void {
        if (document.getElementById('llm-capture-save-btn')) {
            return;
        }

        const conversationId = currentAdapter?.extractConversationId(window.location.href);
        if (!conversationId) {
            console.debug('[Blackiya] No conversation ID found. Button will not be injected.');
            removeSaveButton();
            return;
        }

        const target = currentAdapter?.getButtonInjectionTarget();
        if (!target) {
            console.log('[Blackiya] Injection target not found, will retry...');
            return;
        }

        saveButton = createSaveButton();

        // If injecting into body/html (fallback), use fixed positioning
        if (target === document.body || target === document.documentElement) {
            isFixedPosition = true;
            updateButtonStyles('default');
        } else {
            isFixedPosition = false;
        }

        target.appendChild(saveButton);
        currentConversationId = conversationId;
        console.log('[Blackiya] Save button injected for conversation:', conversationId);
    }

    function removeSaveButton(): void {
        if (saveButton?.parentElement) {
            saveButton.parentElement.removeChild(saveButton);
        }
        saveButton = null;
        currentConversationId = null;
    }

    function handleNavigationChange(): void {
        if (!currentAdapter) {
            return;
        }

        const newConversationId = currentAdapter.extractConversationId(window.location.href);
        if (newConversationId !== currentConversationId) {
            removeSaveButton();
            if (newConversationId) {
                setTimeout(injectSaveButton, 500);
            }
        }
    }

    function setupNavigationObserver(): void {
        let navigationTimeout: number | undefined;

        navigationObserver = new MutationObserver(() => {
            if (navigationTimeout) {
                clearTimeout(navigationTimeout);
            }

            navigationTimeout = window.setTimeout(() => {
                handleNavigationChange();
                if (currentConversationId && !document.getElementById('llm-capture-save-btn')) {
                    injectSaveButton();
                }
            }, 100);
        });

        navigationObserver.observe(document.body, {
            childList: true,
            subtree: true,
        });

        window.addEventListener('popstate', handleNavigationChange);
    }

    function addStyles(): void {
        const style = document.createElement('style');
        style.textContent = `
            @keyframes spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
    }

    // Initialization
    currentAdapter = getPlatformAdapter(window.location.href);
    if (!currentAdapter) {
        console.warn('[Blackiya] No matching platform adapter for this URL');
        return;
    }

    console.log(`[Blackiya] Content script running for ${currentAdapter.name}`);
    addStyles();
    setupInterceptorListener();
    currentConversationId = currentAdapter.extractConversationId(window.location.href);
    setupNavigationObserver();
    injectSaveButton();

    const retryIntervals = [1000, 2000, 5000];
    for (const delay of retryIntervals) {
        setTimeout(() => {
            if (!document.getElementById('llm-capture-save-btn')) {
                injectSaveButton();
            }
        }, delay);
    }
}
