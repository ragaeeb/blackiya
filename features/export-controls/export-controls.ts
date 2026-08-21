import { logger } from '@/utils/logger';
import {
    defaultExportControlsTimings,
    EXPORT_CHAT_BUTTON_ID,
    EXPORT_CONTROLS_CONTAINER_ATTR,
    EXPORT_CONTROLS_CONTAINER_ID,
    EXPORT_ERROR_KIND_ATTR,
    type ExportActionContext,
    type ExportControls,
    type ExportControlsDependencies,
    type ExportControlsState,
    type ExportControlsTimings,
} from './contract';

const IDLE_LABEL = 'Save JSON';
const LOADING_LABEL = 'Saving…';
const SUCCESS_LABEL = '✓ Saved';
const ERROR_LABEL = '⚠ Failed';

const CONTAINER_STYLES = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 10000;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px;
    background: rgba(30, 30, 30, 0.8);
    backdrop-filter: blur(4px);
    border-radius: 12px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
`;

const BUTTON_BACKGROUND_IDLE = 'linear-gradient(135deg, #10a37f 0%, #0d8a6a 100%)';
const BUTTON_BACKGROUND_ERROR = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';

const STATE_LABELS: Record<ExportControlsState, string> = {
    idle: IDLE_LABEL,
    loading: LOADING_LABEL,
    success: SUCCESS_LABEL,
    error: ERROR_LABEL,
};

const STATE_TITLES: Record<ExportControlsState, string> = {
    idle: 'Save conversation JSON (current data)',
    loading: 'Saving JSON...',
    success: 'JSON saved',
    error: 'Save failed. Click to retry.',
};

const removeStaleControls = () => {
    const marked = document.querySelectorAll(
        `[${EXPORT_CONTROLS_CONTAINER_ATTR}="1"], #${EXPORT_CONTROLS_CONTAINER_ID}`,
    );
    for (const element of Array.from(marked)) {
        element.parentElement?.removeChild(element);
    }
};

const createContainer = (): HTMLElement => {
    const container = document.createElement('div');
    container.id = EXPORT_CONTROLS_CONTAINER_ID;
    container.setAttribute(EXPORT_CONTROLS_CONTAINER_ATTR, '1');
    container.style.cssText = CONTAINER_STYLES;
    return container;
};

const createButton = (onClick: () => void): HTMLButtonElement => {
    const button = document.createElement('button');
    button.id = EXPORT_CHAT_BUTTON_ID;
    button.type = 'button';
    button.textContent = IDLE_LABEL;
    button.title = 'Save conversation JSON (current data)';
    button.setAttribute('aria-label', button.title);
    button.style.cssText = `
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 6px 12px;
        border: none;
        border-radius: 8px;
        background: ${BUTTON_BACKGROUND_IDLE};
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        line-height: 1;
        cursor: pointer;
        transition: filter 0.2s ease, opacity 0.2s ease;
    `;
    button.addEventListener('click', onClick);
    return button;
};

export const createExportControls = (
    dependencies: ExportControlsDependencies,
    timings: Partial<ExportControlsTimings> = {},
): ExportControls => {
    const resolvedTimings: ExportControlsTimings = { ...defaultExportControlsTimings(), ...timings };

    let container: HTMLElement | null = null;
    let button: HTMLButtonElement | null = null;
    let state: ExportControlsState = 'idle';
    let resetTimer: ReturnType<typeof setTimeout> | null = null;
    let reinjectionObserver: MutationObserver | null = null;

    const clearResetTimer = () => {
        if (resetTimer) {
            clearTimeout(resetTimer);
            resetTimer = null;
        }
    };

    const render = () => {
        if (!button) {
            return;
        }
        button.textContent = STATE_LABELS[state];
        button.disabled = state !== 'idle';
        button.style.background = state === 'error' ? BUTTON_BACKGROUND_ERROR : BUTTON_BACKGROUND_IDLE;
        button.title = STATE_TITLES[state];
        button.setAttribute('aria-label', button.title);
    };

    const setState = (next: ExportControlsState) => {
        state = next;
        render();
        if (next !== 'error') {
            button?.removeAttribute(EXPORT_ERROR_KIND_ATTR);
        }
    };

    const setErrorKind = (error: unknown) => {
        const kind =
            error && typeof error === 'object' && 'kind' in error && typeof error.kind === 'string'
                ? error.kind
                : 'unknown';
        button?.setAttribute(EXPORT_ERROR_KIND_ATTR, kind);
    };

    const scheduleIdleReset = (delayMs: number) => {
        clearResetTimer();
        resetTimer = setTimeout(() => {
            resetTimer = null;
            setState('idle');
        }, delayMs);
    };

    const ensureMountedAtBody = () => {
        if (!container || !document.body) {
            return;
        }
        if (!container.isConnected || container.parentElement !== document.body) {
            document.body.appendChild(container);
        }
    };

    const ensureReinjectionObserver = () => {
        if (reinjectionObserver || typeof MutationObserver === 'undefined' || !document.body) {
            return;
        }
        reinjectionObserver = new MutationObserver(() => {
            if (!container) {
                reinjectionObserver?.disconnect();
                reinjectionObserver = null;
                return;
            }
            ensureMountedAtBody();
        });
        reinjectionObserver.observe(document.body, { childList: true, subtree: true });
    };

    const handleExportClick = () => {
        if (state === 'loading') {
            return;
        }

        clearResetTimer();

        let context: ExportActionContext;
        try {
            context = dependencies.resolveActionContext();
        } catch (error) {
            logger.warn('Failed to resolve export action context', error);
            setState('error');
            setErrorKind(error);
            scheduleIdleReset(resolvedTimings.errorResetMs);
            return;
        }

        setState('loading');
        void Promise.resolve()
            .then(() => dependencies.onExport(context))
            .then(() => {
                setState('success');
                scheduleIdleReset(resolvedTimings.successResetMs);
            })
            .catch((error) => {
                logger.warn('Single-chat export failed', error);
                setState('error');
                setErrorKind(error);
                scheduleIdleReset(resolvedTimings.errorResetMs);
            });
    };

    const mount = (): HTMLElement => {
        if (container?.isConnected && container.parentElement === document.body) {
            return container;
        }

        clearResetTimer();
        removeStaleControls();

        container = createContainer();
        button = createButton(handleExportClick);
        container.appendChild(button);
        document.body.appendChild(container);
        setState(state);

        ensureReinjectionObserver();
        logger.info('V3 export controls mounted');
        return container;
    };

    const destroy = () => {
        clearResetTimer();
        reinjectionObserver?.disconnect();
        reinjectionObserver = null;
        container?.parentElement?.removeChild(container);
        container = null;
        button = null;
    };

    return {
        mount,
        destroy,
        getElement: () => container,
        getButton: () => button,
        getState: () => state,
    };
};
