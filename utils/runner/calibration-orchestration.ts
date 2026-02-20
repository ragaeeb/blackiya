/**
 * Calibration orchestration — manages the calibration capture lifecycle.
 *
 * Handles preference loading/saving, calibration arm/capture/success flow,
 * and UI synchronisation. All runner-state access goes through deps.
 */

import type { LLMPlatform } from '@/platforms/types';
import {
    buildCalibrationProfileFromStep,
    loadCalibrationProfileV2IfPresent,
    saveCalibrationProfileV2,
    stepFromStrategy,
} from '@/utils/calibration-profile';
import { logger } from '@/utils/logger';
import {
    buildCalibrationOrderForMode,
    type CalibrationMode,
    shouldPersistCalibrationProfile,
} from '@/utils/runner/calibration-policy';
import type { CalibrationStep } from '@/utils/runner/calibration-runner';
import { formatCalibrationTimestampLabel, resolveCalibrationDisplayState } from '@/utils/runner/calibration-ui';

type CalibrationUiState = 'idle' | 'waiting' | 'capturing' | 'success' | 'error';

export type CalibrationOrchestrationDeps = {
    getAdapter: () => LLMPlatform | null;
    getCalibrationState: () => CalibrationUiState;
    setCalibrationState: (state: CalibrationUiState) => void;
    getRememberedPreferredStep: () => CalibrationStep | null;
    setRememberedPreferredStep: (step: CalibrationStep | null) => void;
    getRememberedCalibrationUpdatedAt: () => string | null;
    setRememberedCalibrationUpdatedAt: (at: string | null) => void;
    isCalibrationPreferenceLoaded: () => boolean;
    setCalibrationPreferenceLoaded: (loaded: boolean) => void;
    getCalibrationPreferenceLoading: () => Promise<void> | null;
    setCalibrationPreferenceLoading: (promise: Promise<void> | null) => void;
    runCalibrationStep: (step: CalibrationStep, conversationId: string, mode: CalibrationMode) => Promise<boolean>;
    isConversationReadyForActions: (conversationId: string) => boolean;
    hasConversationData: (conversationId: string) => boolean;
    refreshButtonState: (conversationId: string) => void;
    buttonManagerExists: () => boolean;
    buttonManagerSetCalibrationState: (state: CalibrationUiState, options: { timestampLabel: string | null }) => void;
    syncRunnerStateCalibration: (state: CalibrationUiState) => void;
};

const setCalibrationStatus = (status: CalibrationUiState, deps: CalibrationOrchestrationDeps) => {
    deps.setCalibrationState(status);
    deps.syncRunnerStateCalibration(status);
    deps.buttonManagerSetCalibrationState(status, {
        timestampLabel:
            status === 'success' ? formatCalibrationTimestampLabel(deps.getRememberedCalibrationUpdatedAt()) : null,
    });
};

const markCalibrationSuccess = (conversationId: string, deps: CalibrationOrchestrationDeps) => {
    setCalibrationStatus('success', deps);
    deps.refreshButtonState(conversationId);
};

export const loadCalibrationPreference = async (platformName: string, deps: CalibrationOrchestrationDeps) => {
    try {
        const profileV2 = await loadCalibrationProfileV2IfPresent(platformName);
        if (profileV2) {
            deps.setRememberedPreferredStep(stepFromStrategy(profileV2.strategy));
            deps.setRememberedCalibrationUpdatedAt(profileV2.updatedAt);
        } else {
            deps.setRememberedPreferredStep(null);
            deps.setRememberedCalibrationUpdatedAt(null);
        }
        deps.setCalibrationPreferenceLoaded(true);
        syncCalibrationButtonDisplay(deps);
    } catch (error) {
        logger.warn('Failed to load calibration profile', error);
        deps.setCalibrationPreferenceLoaded(true);
        syncCalibrationButtonDisplay(deps);
    }
};

export const ensureCalibrationPreferenceLoaded = (
    platformName: string,
    deps: CalibrationOrchestrationDeps,
): Promise<void> => {
    if (deps.isCalibrationPreferenceLoaded()) {
        return Promise.resolve();
    }
    const existing = deps.getCalibrationPreferenceLoading();
    if (existing) {
        return existing;
    }
    const promise = loadCalibrationPreference(platformName, deps).finally(() => {
        deps.setCalibrationPreferenceLoading(null);
    });
    deps.setCalibrationPreferenceLoading(promise);
    return promise;
};

const rememberCalibrationSuccess = async (
    platformName: string,
    step: CalibrationStep,
    deps: CalibrationOrchestrationDeps,
) => {
    try {
        deps.setRememberedPreferredStep(step);
        deps.setRememberedCalibrationUpdatedAt(new Date().toISOString());
        deps.setCalibrationPreferenceLoaded(true);
        await saveCalibrationProfileV2(buildCalibrationProfileFromStep(platformName, step));
    } catch (error) {
        logger.warn('Failed to save calibration profile', error);
    }
};

export const syncCalibrationButtonDisplay = (deps: CalibrationOrchestrationDeps) => {
    if (!deps.buttonManagerExists() || !deps.getAdapter()) {
        return;
    }
    const displayState = resolveCalibrationDisplayState(
        deps.getCalibrationState(),
        !!deps.getRememberedPreferredStep(),
    );
    deps.buttonManagerSetCalibrationState(displayState, {
        timestampLabel:
            displayState === 'success'
                ? formatCalibrationTimestampLabel(deps.getRememberedCalibrationUpdatedAt())
                : null,
    });
};

export const isCalibrationCaptureSatisfied = (
    conversationId: string,
    mode: CalibrationMode,
    deps: CalibrationOrchestrationDeps,
): boolean => {
    if (mode === 'auto') {
        return deps.isConversationReadyForActions(conversationId);
    }
    return deps.hasConversationData(conversationId);
};

export const runCalibrationCapture = async (
    mode: CalibrationMode | undefined,
    hintedConversationId: string | undefined,
    deps: CalibrationOrchestrationDeps,
) => {
    const effectiveMode = mode ?? 'manual';
    const adapter = deps.getAdapter();
    if (deps.getCalibrationState() === 'capturing' || !adapter) {
        return;
    }
    const conversationId = hintedConversationId || adapter.extractConversationId(window.location.href);
    if (!conversationId) {
        logger.warn('Calibration failed: no conversation ID');
        setCalibrationStatus('error', deps);
        return;
    }

    setCalibrationStatus('capturing', deps);
    logger.info('Calibration capture started', { conversationId, platform: adapter.name });
    const strategyOrder = buildCalibrationOrderForMode(deps.getRememberedPreferredStep(), effectiveMode, adapter.name);
    logger.info('Calibration strategy', {
        platform: adapter.name,
        steps: strategyOrder,
        mode: effectiveMode,
        remembered: deps.getRememberedPreferredStep(),
    });

    let successfulStep: CalibrationStep | null = null;
    for (const step of strategyOrder) {
        if (await deps.runCalibrationStep(step, conversationId, effectiveMode)) {
            successfulStep = step;
            break;
        }
    }

    if (successfulStep) {
        if (effectiveMode === 'manual') {
            markCalibrationSuccess(conversationId, deps);
        } else {
            setCalibrationStatus('success', deps);
            deps.refreshButtonState(conversationId);
        }
        if (shouldPersistCalibrationProfile(effectiveMode)) {
            await rememberCalibrationSuccess(adapter.name, successfulStep, deps);
        }
        logger.info('Calibration capture succeeded', { conversationId, step: successfulStep, mode: effectiveMode });
    } else {
        if (effectiveMode === 'manual') {
            setCalibrationStatus('error', deps);
            deps.refreshButtonState(conversationId);
        } else {
            setCalibrationStatus('idle', deps);
        }
        logger.warn('Calibration capture failed after retries', { conversationId });
    }
};

export const handleCalibrationClick = async (deps: CalibrationOrchestrationDeps) => {
    if (deps.getCalibrationState() === 'capturing') {
        return;
    }
    if (deps.getCalibrationState() === 'waiting') {
        await runCalibrationCapture('manual', undefined, deps);
        return;
    }
    setCalibrationStatus('waiting', deps);
    logger.info('Calibration armed. Click Done when response is complete.');
};
