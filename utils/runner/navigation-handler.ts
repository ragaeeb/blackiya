/**
 * SPA navigation handling — conversation switching, adapter re-resolution,
 * and in-flight attempt disposal on route change.
 *
 * Dependencies are injected so the module is unit-testable without a live
 * runner closure.
 */

import { getPlatformAdapter } from '@/platforms/factory';
import type { LLMPlatform } from '@/platforms/types';
import { logger } from '@/utils/logger';
import type { RunnerLifecycleUiState } from '@/utils/runner/state';

export type NavigationDeps = {
    getCurrentAdapter: () => LLMPlatform | null;
    getCurrentConversationId: () => string | null;
    getLifecycleState: () => RunnerLifecycleUiState;
    isLifecycleActiveGeneration: () => boolean;
    setCurrentConversation: (id: string | null) => void;
    setLifecycleState: (state: RunnerLifecycleUiState, conversationId?: string) => void;
    updateAdapter: (adapter: LLMPlatform) => void;
    disposeInFlightAttempts: (preserveConversationId?: string | null) => void;
    buttonManagerRemove: () => void;
    buttonManagerExists: () => boolean;
    injectSaveButton: () => void;
    refreshButtonState: (conversationId?: string) => void;
    resetCalibrationPreference: () => void;
    ensureCalibrationPreferenceLoaded: (platformName: string) => Promise<void>;
    warmFetch: (conversationId: string, reason: 'conversation-switch') => Promise<boolean>;
    scheduleAutoCapture: (conversationId: string, reason: 'navigation') => void;
};

/**
 * Handles a full conversation switch (new conversation ID or null).
 * Disposes in-flight attempts (unless this is a first-prompt navigation),
 * updates adapter and lifecycle state, and kicks off background warm-fetch.
 */
export const switchConversation = (newId: string | null, deps: NavigationDeps) => {
    const currentConversationId = deps.getCurrentConversationId();
    const isNewConversationNavigation =
        !currentConversationId && deps.isLifecycleActiveGeneration() && !!newId;
    if (!isNewConversationNavigation) {
        deps.disposeInFlightAttempts(newId);
    }
    if (!newId) {
        deps.setCurrentConversation(null);
        if (!deps.isLifecycleActiveGeneration()) {
            deps.setLifecycleState('idle');
        }
        setTimeout(() => deps.injectSaveButton(), 300);
        return;
    }
    if (!isNewConversationNavigation) {
        deps.buttonManagerRemove();
    }
    deps.setCurrentConversation(newId);

    const currentAdapter = deps.getCurrentAdapter();
    const newAdapter = getPlatformAdapter(window.location.href);
    if (newAdapter && currentAdapter && newAdapter.name !== currentAdapter.name) {
        deps.updateAdapter(newAdapter);
        deps.resetCalibrationPreference();
        void deps.ensureCalibrationPreferenceLoaded(newAdapter.name);
    }

    if (isNewConversationNavigation) {
        logger.info('Conversation switch -> preserving active lifecycle', {
            newId,
            preservedState: deps.getLifecycleState(),
        });
        deps.setLifecycleState(deps.getLifecycleState(), newId);
    } else {
        setTimeout(() => deps.injectSaveButton(), 500);
        logger.info('Conversation switch -> idle', { newId, previousState: deps.getLifecycleState() });
        deps.setLifecycleState('idle', newId);
    }
    void deps.warmFetch(newId, 'conversation-switch');
    setTimeout(() => {
        deps.scheduleAutoCapture(newId, 'navigation');
    }, 1800);
};

/**
 * Called on any URL / history change. Determines whether the conversation
 * changed and triggers the appropriate refresh or full conversation switch.
 */
export const handleNavigationChange = (deps: NavigationDeps) => {
    const adapter = deps.getCurrentAdapter();
    if (!adapter) {
        return;
    }
    const newConversationId = adapter.extractConversationId(window.location.href);
    if (newConversationId !== deps.getCurrentConversationId()) {
        switchConversation(newConversationId, deps);
    } else {
        if (newConversationId && !deps.buttonManagerExists()) {
            setTimeout(() => deps.injectSaveButton(), 500);
        } else {
            deps.refreshButtonState(newConversationId || undefined);
        }
    }
};
