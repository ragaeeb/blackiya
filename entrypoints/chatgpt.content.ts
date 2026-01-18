/**
 * ChatGPT Content Script
 *
 * Injects a "Save Conversation" button into the ChatGPT UI and handles
 * capturing and downloading conversation JSON data.
 *
 * @module entrypoints/chatgpt.content
 */

import { chatGPTAdapter } from '../platforms/chatgpt';
import { downloadAsJSON } from '../utils/download';
import type { ConversationData } from '../utils/types';

/**
 * Button element reference for cleanup
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
 * Handle save button click
 */
async function handleSaveClick(): Promise<void> {
    const conversationId = chatGPTAdapter.extractConversationId(window.location.href);

    if (!conversationId) {
        console.error('[LLM Capture] No conversation ID found in URL');
        return;
    }

    setButtonLoading(true);

    try {
        const apiUrl = chatGPTAdapter.buildApiUrl(conversationId);
        const response = await fetch(apiUrl, {
            method: 'GET',
            credentials: 'include', // Include session cookies
            headers: {
                Accept: 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`API request failed: ${response.status} ${response.statusText}`);
        }

        const data: ConversationData = await response.json();
        const filename = chatGPTAdapter.formatFilename(data);

        downloadAsJSON(data, filename);

        console.log(`[LLM Capture] Saved conversation: ${filename}.json`);
    } catch (error) {
        console.error('[LLM Capture] Failed to save conversation:', error);
    } finally {
        setButtonLoading(false);
    }
}

/**
 * Find a suitable injection target in the ChatGPT UI
 *
 * Looks for the model selector area or header navigation
 */
function findInjectionTarget(): HTMLElement | null {
    // Try to find the header/navigation area where model selector lives
    // ChatGPT UI structure: look for the dropdown button near the top
    const selectors = [
        // Model selector button container
        '[data-testid="model-switcher-dropdown-button"]',
        // Header navigation area
        'header nav',
        // Main content area top bar
        '.flex.items-center.justify-between',
        // Fallback: any flex container in header
        'header .flex',
    ];

    for (const selector of selectors) {
        const target = document.querySelector(selector);
        if (target) {
            return target.parentElement || (target as HTMLElement);
        }
    }

    return null;
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
    const conversationId = chatGPTAdapter.extractConversationId(window.location.href);
    if (!conversationId) {
        // Not on a conversation page, remove button if it exists
        removeSaveButton();
        return;
    }

    const target = findInjectionTarget();
    if (!target) {
        // Target not found, retry later
        console.log('[LLM Capture] Injection target not found, will retry...');
        return;
    }

    saveButton = createSaveButton();
    target.appendChild(saveButton);
    currentConversationId = conversationId;

    console.log('[LLM Capture] Save button injected for conversation:', conversationId);
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
    const newConversationId = chatGPTAdapter.extractConversationId(window.location.href);

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
    addStyles();
    injectSaveButton();
    setupNavigationObserver();

    // Retry injection a few times in case the page is still loading
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
    matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    runAt: 'document_idle',
    main() {
        console.log('[LLM Capture] ChatGPT content script loaded');
        initialize();
    },
});
