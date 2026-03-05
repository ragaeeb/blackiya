/**
 * Payload Quality Toast
 *
 * Injects a dismissible error toast into the page when payload quality
 * issues are detected. The user must explicitly click to dismiss.
 *
 * Designed to be called from the ISOLATED world content script.
 *
 * @module utils/payload-quality-toast
 */

import type { PayloadQualityIssue, PayloadQualityResult } from '@/utils/payload-quality-gate';

const TOAST_CONTAINER_ID = 'blackiya-quality-toast-container';

const ISSUE_LABELS: Record<PayloadQualityIssue, string> = {
    missing_model: 'Model name missing',
    empty_reasoning: 'Reasoning/thinking data missing',
};

const buildToastHTML = (conversationId: string, platform: string, quality: PayloadQualityResult): string => {
    const issueList = quality.issues.map((issue) => `<li>${ISSUE_LABELS[issue]}</li>`).join('');

    return `
        <div style="
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 2147483647;
            max-width: 420px;
            background: #1a1a2e;
            border: 2px solid #e94560;
            border-radius: 12px;
            padding: 16px 20px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            font-size: 13px;
            color: #e8e8e8;
            box-shadow: 0 8px 32px rgba(233, 69, 96, 0.3), 0 2px 8px rgba(0,0,0,0.4);
            animation: blackiya-toast-slide-in 0.3s ease-out;
        " id="${TOAST_CONTAINER_ID}">
            <style>
                @keyframes blackiya-toast-slide-in {
                    from { transform: translateY(20px); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
            </style>
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
                <span style="font-size: 18px;">⚠️</span>
                <strong style="color: #e94560; font-size: 14px;">Blackiya: Payload Quality Issue</strong>
            </div>
            <div style="margin-bottom: 8px; color: #b0b0b0;">
                <span style="color: #8888cc;">${platform}</span> conversation
                <code style="
                    background: #2a2a3e;
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-size: 11px;
                    color: #a0a0d0;
                ">${conversationId.slice(0, 12)}…</code>
                was saved with degraded data:
            </div>
            <ul style="margin: 0 0 12px 16px; padding: 0; color: #ff8a8a; line-height: 1.6;">
                ${issueList}
            </ul>
            <div style="display: flex; gap: 8px; justify-content: flex-end;">
                <button onclick="document.getElementById('${TOAST_CONTAINER_ID}').remove()" style="
                    background: #2a2a3e;
                    color: #e8e8e8;
                    border: 1px solid #444;
                    border-radius: 6px;
                    padding: 6px 16px;
                    cursor: pointer;
                    font-size: 12px;
                    transition: background 0.15s;
                " onmouseover="this.style.background='#3a3a4e'" onmouseout="this.style.background='#2a2a3e'"
                >Dismiss</button>
            </div>
        </div>
    `;
};

/**
 * Shows a dismissible error toast when payload quality issues are detected.
 * Removes any existing toast first to avoid stacking.
 */
export const showPayloadQualityToast = (
    conversationId: string,
    platform: string,
    quality: PayloadQualityResult,
): void => {
    try {
        // Remove existing toast if present
        const existing = document.getElementById(TOAST_CONTAINER_ID);
        if (existing) {
            existing.remove();
        }

        const wrapper = document.createElement('div');
        wrapper.innerHTML = buildToastHTML(conversationId, platform, quality);
        const toast = wrapper.firstElementChild;
        if (toast) {
            document.body.appendChild(toast);
        }
    } catch {
        // Silently fail — toast is non-critical
    }
};

/**
 * Removes the quality toast if present.
 */
export const dismissPayloadQualityToast = (): void => {
    try {
        const existing = document.getElementById(TOAST_CONTAINER_ID);
        if (existing) {
            existing.remove();
        }
    } catch {
        // Silently fail
    }
};

/** Pending toast timers keyed by conversationId. */
const pendingToasts = new Map<string, ReturnType<typeof setTimeout>>();

/** Delay before showing the toast — gives conversation.updated time to arrive with richer data. */
const TOAST_DELAY_MS = 3_000;

/**
 * Schedules a quality toast after a delay. If a subsequent event with passing
 * quality arrives before the timer fires, the toast is cancelled.
 */
export const scheduleQualityToast = (conversationId: string, platform: string, quality: PayloadQualityResult): void => {
    // Cancel any existing pending toast for this conversation
    cancelQualityToast(conversationId);

    const timerId = setTimeout(() => {
        pendingToasts.delete(conversationId);
        showPayloadQualityToast(conversationId, platform, quality);
    }, TOAST_DELAY_MS);

    pendingToasts.set(conversationId, timerId);
};

/**
 * Cancels a pending quality toast for the given conversation.
 */
export const cancelQualityToast = (conversationId: string): void => {
    const timerId = pendingToasts.get(conversationId);
    if (timerId !== undefined) {
        clearTimeout(timerId);
        pendingToasts.delete(conversationId);
    }
};
