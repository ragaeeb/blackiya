import type { LLMPlatform } from '@/platforms/types';
import { logger } from '@/utils/logger';
import { resolveTokenValidationFailureReason } from '@/utils/protocol/session-token';
import { dispatchRunnerMessage } from '@/utils/runner/message-bridge';

export type RunnerWindowBridgeDeps = {
    messageHandlers: Array<(message: unknown) => boolean>;
    handleJsonBridgeRequest: (message: unknown) => void;
    invalidSessionTokenLogAtRef: { value: number };
    invalidSessionTokenLogThrottleMs?: number;
};

const isSameWindowOrigin = (event: MessageEvent) => event.source === window && event.origin === window.location.origin;

export const registerWindowBridge = (deps: RunnerWindowBridgeDeps) => {
    const throttleMs = deps.invalidSessionTokenLogThrottleMs ?? 1500;
    const handler = (event: MessageEvent) => {
        if (!isSameWindowOrigin(event)) {
            return;
        }
        const tokenFailureReason = resolveTokenValidationFailureReason(event.data);
        if (tokenFailureReason !== null) {
            const now = Date.now();
            if (now - deps.invalidSessionTokenLogAtRef.value > throttleMs) {
                deps.invalidSessionTokenLogAtRef.value = now;
                logger.debug('Dropped message due to session token validation failure', {
                    reason: tokenFailureReason,
                });
            }
            return;
        }
        const handled = dispatchRunnerMessage(event.data, deps.messageHandlers);
        if (!handled) {
            deps.handleJsonBridgeRequest(event.data);
        }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
};

export type CompletionWatcherDeps = {
    getAdapter: () => LLMPlatform | null;
    isPlatformGenerating: () => boolean;
    handleResponseFinished: (source: 'network' | 'dom', hintedConversationId?: string) => void;
};

export const registerCompletionWatcher = (deps: CompletionWatcherDeps) => {
    if (deps.getAdapter()?.name !== 'ChatGPT') {
        return () => {};
    }
    let wasGenerating = deps.isPlatformGenerating();
    const checkTransition = () => {
        const generating = deps.isPlatformGenerating();
        if (wasGenerating && !generating) {
            deps.handleResponseFinished('dom');
        }
        wasGenerating = generating;
    };
    const observer = new MutationObserver(checkTransition);
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-testid', 'aria-label', 'data-is-streaming'],
    });
    const intervalId = window.setInterval(checkTransition, 800);
    return () => {
        observer.disconnect();
        clearInterval(intervalId);
    };
};

export type ButtonHealthCheckDeps = {
    getAdapter: () => LLMPlatform | null;
    extractConversationIdFromLocation: () => string | null;
    buttonManagerExists: () => boolean;
    injectSaveButton: () => void;
    refreshButtonState: (conversationId?: string) => void;
};

const resolveHealthCheckIntervalMs = () => {
    const configured = (window as any).__BLACKIYA_TEST_HEALTH_CHECK_INTERVAL_MS;
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
        return configured;
    }
    return 1800;
};

export const registerButtonHealthCheck = (deps: ButtonHealthCheckDeps) => {
    const intervalId = window.setInterval(() => {
        if (!deps.getAdapter()) {
            return;
        }
        const activeConversationId = deps.extractConversationIdFromLocation();
        if (!activeConversationId) {
            deps.refreshButtonState(undefined);
            return;
        }
        if (!deps.buttonManagerExists()) {
            deps.injectSaveButton();
            return;
        }
        deps.refreshButtonState(activeConversationId);
    }, resolveHealthCheckIntervalMs());
    return () => clearInterval(intervalId);
};
