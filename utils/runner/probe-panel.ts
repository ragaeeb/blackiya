/**
 * Stream probe panel — a fixed-position overlay used during diagnostics.
 *
 * All DOM manipulation for the panel lives here so the runner orchestrator
 * only deals with logical state (visible/hidden, status strings).
 */

type StreamProbeDockPosition = 'bottom-left' | 'top-left';

/**
 * Resolves the on-screen docking position for the stream probe panel.
 * Gemini surfaces dock to the top-left to avoid overlapping the chat input.
 */
export const resolveStreamProbeDockPosition = (platformName: string, hostname: string): StreamProbeDockPosition => {
    if (platformName.toLowerCase() === 'gemini' || /(^|\.)gemini\.google\.com$/i.test(hostname)) {
        return 'top-left';
    }
    return 'bottom-left';
};

const applyStreamProbeDocking = (panel: HTMLDivElement, position: StreamProbeDockPosition) => {
    if (position === 'top-left') {
        panel.style.left = '16px';
        panel.style.right = 'auto';
        panel.style.top = '16px';
        panel.style.bottom = 'auto';
    } else {
        panel.style.left = '16px';
        panel.style.right = 'auto';
        panel.style.top = 'auto';
        panel.style.bottom = '16px';
    }
};

const normalizeStreamProbePanelInteraction = (panel: HTMLDivElement) => {
    panel.style.maxHeight = '42vh';
    panel.style.overflow = 'auto';
    panel.style.pointerEvents = 'auto';
    panel.style.touchAction = 'pan-y';
    panel.style.overscrollBehavior = 'contain';
};

const PANEL_ID = 'blackiya-stream-probe';

/**
 * Returns the existing probe panel (updating its docking/interaction styles),
 * or creates and appends a new one. Returns `null` when `visible` is `false`.
 */
export const ensureStreamProbePanel = (
    visible: boolean,
    dockPosition: StreamProbeDockPosition,
): HTMLDivElement | null => {
    if (!visible) {
        return null;
    }
    const existing = document.getElementById(PANEL_ID) as HTMLDivElement | null;
    if (existing) {
        normalizeStreamProbePanelInteraction(existing);
        applyStreamProbeDocking(existing, dockPosition);
        return existing;
    }

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = `
        position: fixed;
        left: 16px;
        right: auto;
        top: auto;
        bottom: 16px;
        width: min(560px, calc(100vw - 32px));
        max-height: 42vh;
        overflow: auto;
        z-index: 2147483647;
        background: rgba(15, 23, 42, 0.92);
        color: #e2e8f0;
        border: 1px solid rgba(148, 163, 184, 0.45);
        border-radius: 10px;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
        font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        padding: 10px;
        white-space: pre-wrap;
        word-break: break-word;
        pointer-events: auto;
    `;
    normalizeStreamProbePanelInteraction(panel);
    applyStreamProbeDocking(panel, dockPosition);
    document.body.appendChild(panel);
    return panel;
};

/**
 * Writes a timestamped status + body string into the probe panel.
 * No-ops when the panel does not exist or `visible` is false.
 */
export const setStreamProbePanelContent = (panel: HTMLDivElement, status: string, body: string) => {
    const now = new Date().toLocaleTimeString();
    panel.textContent = `[Blackiya Stream Probe] ${status} @ ${now}\n\n${body}`;
};

/**
 * Removes the probe panel from the DOM if it exists.
 */
export const removeStreamProbePanel = () => {
    const panel = document.getElementById(PANEL_ID);
    if (panel?.parentNode) {
        panel.parentNode.removeChild(panel);
    }
};
