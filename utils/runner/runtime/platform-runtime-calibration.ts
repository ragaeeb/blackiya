import { browser } from 'wxt/browser';
import type { LLMPlatform } from '@/platforms/types';
import { logger } from '@/utils/logger';
import type { AutoCaptureDeps, AutoCaptureReason } from '@/utils/runner/auto-capture';
import { maybeRunAutoCapture as maybeRunAutoCaptureCore } from '@/utils/runner/auto-capture';
import type { CalibrationCaptureDeps } from '@/utils/runner/calibration-capture';
import type { CalibrationOrchestrationDeps } from '@/utils/runner/calibration-orchestration';
import {
    ensureCalibrationPreferenceLoaded as ensureCalibrationPreferenceLoadedCore,
    isCalibrationCaptureSatisfied as isCalibrationCaptureSatisfiedCore,
    runCalibrationCapture as runCalibrationCaptureCore,
    syncCalibrationButtonDisplay as syncCalibrationButtonDisplayCore,
} from '@/utils/runner/calibration-orchestration';
import type { CalibrationMode } from '@/utils/runner/calibration-policy';
import type { CalibrationStep } from '@/utils/runner/calibration-runner';
import { detectPlatformGenerating } from '@/utils/runner/generation-guard';
import type { WarmFetchDeps, WarmFetchReason } from '@/utils/runner/warm-fetch';
import { warmFetchConversationSnapshot as warmFetchConversationSnapshotCore } from '@/utils/runner/warm-fetch';
import { STORAGE_KEYS } from '@/utils/settings';

export type CalibrationRuntimeDeps = {
    getAdapter: () => LLMPlatform | null;
    getCalibrationState: () => 'idle' | 'waiting' | 'capturing' | 'success' | 'error';
    setCalibrationState: (state: 'idle' | 'waiting' | 'capturing' | 'success' | 'error') => void;
    getRememberedPreferredStep: () => CalibrationStep | null;
    setRememberedPreferredStep: (step: CalibrationStep | null) => void;
    getRememberedCalibrationUpdatedAt: () => string | null;
    setRememberedCalibrationUpdatedAt: (at: string | null) => void;
    isCalibrationPreferenceLoaded: () => boolean;
    setCalibrationPreferenceLoaded: (loaded: boolean) => void;
    getCalibrationPreferenceLoading: () => Promise<void> | null;
    setCalibrationPreferenceLoading: (promise: Promise<void> | null) => void;
    getSfeEnabled: () => boolean;
    setSfeEnabled: (enabled: boolean) => void;
    runCalibrationStep: (step: CalibrationStep, conversationId: string, mode: CalibrationMode) => Promise<boolean>;
    isConversationReadyForActions: (conversationId: string, options?: { includeDegraded?: boolean }) => boolean;
    hasConversationData: (conversationId: string) => boolean;
    refreshButtonState: (conversationId?: string) => void;
    buttonManagerExists: () => boolean;
    buttonManagerSetCalibrationState: (
        state: 'idle' | 'waiting' | 'capturing' | 'success' | 'error',
        options?: { timestampLabel?: string | null },
    ) => void;
    syncRunnerStateCalibration: (state: 'idle' | 'waiting' | 'capturing' | 'success' | 'error') => void;
    autoCaptureAttempts: Map<string, number>;
    autoCaptureRetryTimers: Map<string, number>;
    autoCaptureDeferredLogged: Set<string>;
    maxAutocaptureKeys: number;
    peekAttemptId: (conversationId: string) => string | null;
    resolveAttemptId: (conversationId: string) => string;
    warmFetchInFlight: Map<string, Promise<boolean>>;
    buildWarmFetchDeps: () => WarmFetchDeps;
    buildCalibrationCaptureDeps: (conversationId: string) => CalibrationCaptureDeps;
};

export const createCalibrationRuntime = (deps: CalibrationRuntimeDeps) => {
    const loadSfeSettings = async () => {
        try {
            const result = await browser.storage.local.get([STORAGE_KEYS.SFE_ENABLED]);
            deps.setSfeEnabled(result[STORAGE_KEYS.SFE_ENABLED] !== false);
            logger.info('SFE settings loaded', {
                sfeEnabled: deps.getSfeEnabled(),
                probeLeaseArbitration: 'always_on',
            });
        } catch (error) {
            logger.warn('Failed to load SFE settings. Falling back to defaults.', error);
            deps.setSfeEnabled(true);
        }
    };

    const buildCalibrationOrchestrationDeps = (): CalibrationOrchestrationDeps => ({
        getAdapter: deps.getAdapter,
        getCalibrationState: deps.getCalibrationState,
        setCalibrationState: deps.setCalibrationState,
        getRememberedPreferredStep: deps.getRememberedPreferredStep,
        setRememberedPreferredStep: deps.setRememberedPreferredStep,
        getRememberedCalibrationUpdatedAt: deps.getRememberedCalibrationUpdatedAt,
        setRememberedCalibrationUpdatedAt: deps.setRememberedCalibrationUpdatedAt,
        isCalibrationPreferenceLoaded: deps.isCalibrationPreferenceLoaded,
        setCalibrationPreferenceLoaded: deps.setCalibrationPreferenceLoaded,
        getCalibrationPreferenceLoading: deps.getCalibrationPreferenceLoading,
        setCalibrationPreferenceLoading: deps.setCalibrationPreferenceLoading,
        runCalibrationStep: deps.runCalibrationStep,
        isConversationReadyForActions: deps.isConversationReadyForActions,
        hasConversationData: deps.hasConversationData,
        refreshButtonState: deps.refreshButtonState,
        buttonManagerExists: deps.buttonManagerExists,
        buttonManagerSetCalibrationState: deps.buttonManagerSetCalibrationState,
        syncRunnerStateCalibration: deps.syncRunnerStateCalibration,
    });

    const ensureCalibrationPreferenceLoaded = (platformName: string) =>
        ensureCalibrationPreferenceLoadedCore(platformName, buildCalibrationOrchestrationDeps());

    const syncCalibrationButtonDisplay = () => syncCalibrationButtonDisplayCore(buildCalibrationOrchestrationDeps());

    const isCalibrationCaptureSatisfied = (conversationId: string, mode: CalibrationMode) =>
        isCalibrationCaptureSatisfiedCore(conversationId, mode, buildCalibrationOrchestrationDeps());

    const runCalibrationCapture = (mode?: CalibrationMode, hintedConversationId?: string) =>
        runCalibrationCaptureCore(mode, hintedConversationId, buildCalibrationOrchestrationDeps());

    const buildAutoCaptureDeps = (): AutoCaptureDeps => ({
        getAdapter: deps.getAdapter,
        getCalibrationState: deps.getCalibrationState,
        isConversationReadyForActions: deps.isConversationReadyForActions,
        isPlatformGenerating: (adapter) => detectPlatformGenerating(adapter),
        peekAttemptId: deps.peekAttemptId,
        resolveAttemptId: deps.resolveAttemptId,
        getRememberedPreferredStep: deps.getRememberedPreferredStep,
        isCalibrationPreferenceLoaded: deps.isCalibrationPreferenceLoaded,
        ensureCalibrationPreferenceLoaded,
        runCalibrationCapture,
        autoCaptureAttempts: deps.autoCaptureAttempts,
        autoCaptureRetryTimers: deps.autoCaptureRetryTimers,
        autoCaptureDeferredLogged: deps.autoCaptureDeferredLogged,
        maxKeys: deps.maxAutocaptureKeys,
    });

    const maybeRunAutoCapture = (conversationId: string, reason: AutoCaptureReason) =>
        maybeRunAutoCaptureCore(conversationId, reason, buildAutoCaptureDeps());

    const warmFetchConversationSnapshot = (conversationId: string, reason: WarmFetchReason) =>
        warmFetchConversationSnapshotCore(conversationId, reason, deps.buildWarmFetchDeps(), deps.warmFetchInFlight);

    const resetCalibrationPreference = () => {
        deps.setCalibrationPreferenceLoaded(false);
        deps.setCalibrationPreferenceLoading(null);
    };

    const handleCalibrationProfilesChanged = () => {
        const adapter = deps.getAdapter();
        if (!adapter) {
            return;
        }
        resetCalibrationPreference();
        deps.autoCaptureAttempts.clear();
        deps.autoCaptureDeferredLogged.clear();
        for (const timerId of deps.autoCaptureRetryTimers.values()) {
            clearTimeout(timerId);
        }
        deps.autoCaptureRetryTimers.clear();
        void ensureCalibrationPreferenceLoaded(adapter.name);
    };

    return {
        buildCalibrationOrchestrationDeps,
        loadSfeSettings,
        ensureCalibrationPreferenceLoaded,
        syncCalibrationButtonDisplay,
        isCalibrationCaptureSatisfied,
        runCalibrationCapture,
        maybeRunAutoCapture,
        warmFetchConversationSnapshot,
        resetCalibrationPreference,
        handleCalibrationProfilesChanged,
    };
};
