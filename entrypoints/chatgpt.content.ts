/**
 * Platform Content Script
 *
 * Injects a "Save JSON" button into the LLM UI and handles
 * capturing and downloading conversation JSON data.
 *
 * @module entrypoints/platform.content
 */

import { getPlatformAdapter } from '../platforms/factory';
import type { LLMPlatform } from '../platforms/types';
import { downloadAsJSON } from '../utils/download';
import type { ConversationData } from '../utils/types';

/**
 * Platform adapter for the current page
 */
/**
 * Platform adapter for the current page
 */
let currentAdapter: LLMPlatform | null = null;

/**
 * Save button element
 */
let saveButton: HTMLButtonElement | null = null;

/**
 * MutationObserver for detecting navigation changes
 */
let navigationObserver: MutationObserver | null = null;

/**
 * Current conversation ID to track navigation
 */
let currentConversationId: string | null = null;

/**
 * Styles for the save button
 */
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

/**
 * Create the save button element
 */
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
    button.style.cssText = BUTTON_STYLES;

    // Add hover effects
    button.addEventListener('mouseenter', () => {
        if (!button.disabled) {
            button.style.cssText = BUTTON_STYLES + BUTTON_HOVER_STYLES;
        }
    });

    button.addEventListener('mouseleave', () => {
        if (!button.disabled) {
            button.style.cssText = BUTTON_STYLES;
        }
    });

    button.addEventListener('click', handleSaveClick);

    // Initial state: dim if no data captured for current conversation
    const conversationId = currentAdapter?.extractConversationId(window.location.href);
    if (conversationId && !capturedConversations.has(conversationId)) {
        button.style.opacity = '0.6';
    }

    return button;
}

/**
 * Set button to loading state
 */
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
        saveButton.style.cssText = BUTTON_STYLES + BUTTON_LOADING_STYLES;
    } else {
        saveButton.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Save JSON
        `;
        saveButton.style.cssText = BUTTON_STYLES;
    }
}

/**
 * Store for captured conversation data
 * maps conversationId -> data
 */
const capturedConversations = new Map<string, ConversationData>();
const MAX_CACHED_CONVERSATIONS = 10;

function cacheConversation(id: string, data: ConversationData): void {
    if (capturedConversations.size >= MAX_CACHED_CONVERSATIONS) {
        const oldestKey = capturedConversations.keys().next().value;
        if (oldestKey) {
            capturedConversations.delete(oldestKey);
        }
    }
    capturedConversations.set(id, data);
}

/**
 * Handle save button click
 */
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

/**
 * Listen for messages from the main world interceptor
 */
function setupInterceptorListener(): void {
    window.addEventListener('message', (event) => {
        // Only accept messages from the same window
        if (event.source !== window) {
            return;
        }

        const message = event.data;
        if (message?.type === 'LLM_CAPTURE_DATA_INTERCEPTED' && message.data) {
            if (!currentAdapter) {
                return;
            }

            const data = currentAdapter.parseInterceptedData(message.data, message.url);

            if (data && data.conversation_id) {
                const conversationId = data.conversation_id;
                cacheConversation(conversationId, data);
                console.log(`[Blackiya] Captured data for conversation: ${conversationId}`);

                // Update the button state if it belongs to this conversation
                const currentId = currentAdapter.extractConversationId(window.location.href);
                if (currentId === conversationId && saveButton) {
                    saveButton.style.opacity = '1';
                }
            }
        }
    });
}

/**
 * Find a suitable injection target in the ChatGPT UI
 *
 * Looks for the model selector area or header navigation
 */
function findInjectionTarget(): HTMLElement | null {
    if (!currentAdapter) {
        return null;
    }
    return currentAdapter.getButtonInjectionTarget();
}

/**
 * Inject the save button into the page
 */
function injectSaveButton(): void {
    // Don't inject if already present
    if (document.getElementById('llm-capture-save-btn')) {
        return;
    }

    // Check if we're on a conversation page
    const conversationId = currentAdapter?.extractConversationId(window.location.href);
    if (!conversationId) {
        // Not on a conversation page, remove button if it exists
        removeSaveButton();
        return;
    }

    const target = findInjectionTarget();
    if (!target) {
        // Target not found, retry later
        console.log('[Blackiya] Injection target not found, will retry...');
        return;
    }

    saveButton = createSaveButton();
    target.appendChild(saveButton);
    currentConversationId = conversationId;

    console.log('[Blackiya] Save button injected for conversation:', conversationId);
}

/**
 * Remove the save button from the page
 */
function removeSaveButton(): void {
    if (saveButton?.parentElement) {
        saveButton.parentElement.removeChild(saveButton);
    }
    saveButton = null;
    currentConversationId = null;
}

/**
 * Handle URL/navigation changes in the SPA
 */
function handleNavigationChange(): void {
    if (!currentAdapter) {
        return;
    }

    const newConversationId = currentAdapter.extractConversationId(window.location.href);

    if (newConversationId !== currentConversationId) {
        // Navigation occurred
        if (newConversationId) {
            // Moved to a different conversation - re-inject button
            removeSaveButton();
            // Delay to allow DOM to update
            setTimeout(injectSaveButton, 500);
        } else {
            // Left conversation page - remove button
            removeSaveButton();
        }
    }
}

/**
 * Setup navigation observer for SPA changes
 */
function setupNavigationObserver(): void {
    // Watch for URL changes by observing the body for major DOM changes
    navigationObserver = new MutationObserver(() => {
        handleNavigationChange();

        // Also check if our button was removed and re-inject if needed
        if (currentConversationId && !document.getElementById('llm-capture-save-btn')) {
            injectSaveButton();
        }
    });

    navigationObserver.observe(document.body, {
        childList: true,
        subtree: true,
    });

    // Also listen for popstate (back/forward navigation)
    window.addEventListener('popstate', handleNavigationChange);
}

/**
 * Add CSS keyframes for loading spinner animation
 */
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

/**
 * Initialize the content script
 */
function initialize(): void {
    if (!currentAdapter) {
        return;
    }

    addStyles();
    setupInterceptorListener();

    // Detect navigation changes (SPA)
    currentConversationId = currentAdapter.extractConversationId(window.location.href);
    setupNavigationObserver();

    // Initial check for injection target
    injectSaveButton();

    // Retry injection a few times as pages load asynchronously
    const retryIntervals = [1000, 2000, 5000];
    for (const delay of retryIntervals) {
        setTimeout(() => {
            if (!document.getElementById('llm-capture-save-btn')) {
                injectSaveButton();
            }
        }, delay);
    }
}

export default defineContentScript({
    matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://gemini.google.com/*'],
    runAt: 'document_idle',
    main() {
        // Identity current platform
        currentAdapter = getPlatformAdapter(window.location.href);

        if (!currentAdapter) {
            console.warn('[Blackiya] No matching platform adapter for this URL');
            return;
        }

        console.log(`[Blackiya] Content script loaded for ${currentAdapter.name}`);
        initialize();
    },
});
