/**
 * Platform Runner Engine
 *
 * Thin orchestrator that creates the engine context, wires coordinators,
 * and drives the boot/cleanup lifecycle. All deps building and utility
 * logic lives in runner-engine-context.ts.
 *
 * @module utils/runner/platform-runner-engine
 */

import { browser } from 'wxt/browser';
import { getPlatformAdapter } from '@/platforms/factory';
import { logger } from '@/utils/logger';
import { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import { InterceptionManager } from '@/utils/managers/interception-manager';
import { NavigationManager } from '@/utils/managers/navigation-manager';
import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import { generateSessionToken, setSessionToken } from '@/utils/protocol/session-token';
import { CrossTabProbeLease } from '@/utils/sfe/cross-tab-probe-lease';
import { ReadinessGate } from '@/utils/sfe/readiness-gate';
import { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';
import { ButtonManager } from '@/utils/ui/button-manager';
import { createAttemptCoordinator } from './attempt-coordinator';
import {
    injectSaveButton as injectSaveButtonCore,
    isConversationReadyForActions as isConversationReadyForActionsCore,
    refreshButtonState as refreshButtonStateCore,
    resolveReadinessDecision as resolveReadinessDecisionCore,
    scheduleButtonRefresh as scheduleButtonRefreshCore,
} from './button-state-manager';
import { runCalibrationStep as runCalibrationStepPure } from './calibration-capture';
import { handleCalibrationClick as handleCalibrationClickCore } from './calibration-orchestration';
import {
    clearCanonicalStabilizationRetry as clearCanonicalStabilizationRetryCore,
    hasCanonicalStabilizationTimedOut as hasCanonicalStabilizationTimedOutCore,
    maybeRestartCanonicalRecoveryAfterTimeout as maybeRestartCanonicalRecoveryAfterTimeoutCore,
    scheduleCanonicalStabilizationRetry as scheduleCanonicalStabilizationRetryCore,
} from './canonical-stabilization-tick';
import { createExternalEventDispatcherState } from './external-event-dispatch';
import { processInterceptionCapture as processInterceptionCaptureCore } from './interception-capture';
import { createCalibrationRuntime } from './platform-runtime-calibration';
import { createStreamProbeRuntime } from './platform-runtime-stream-probe';
import { createRuntimeWiring } from './platform-runtime-wiring';
import { processResponseFinished as processResponseFinishedCore } from './response-finished-handler';
import type { EngineCtx } from './runner-engine-context';
import {
    buildAttemptCoordinatorDeps,
    buildButtonStateManagerDeps,
    buildCalibrationCaptureDeps,
    buildCalibrationRuntimeDeps,
    buildCanonicalStabilizationTickDeps,
    buildCleanupRuntimeDeps,
    buildExportPayloadForFormat,
    buildInterceptionCaptureDeps,
    buildResponseFinishedDeps,
    buildRuntimeWiringDeps,
    buildSavePipelineDeps,
    buildStorageChangeListenerDeps,
    buildStreamDoneCoordinatorDeps,
    buildStreamDumpSettingDeps,
    buildStreamProbeVisibilitySettingDeps,
    buildVisibilityRecoveryDeps,
    buildWarmFetchDeps,
    emitAttemptDisposed,
    emitExternalConversationEvent,
    evaluateReadinessForData,
    extractConversationIdFromLocation,
    getCaptureMeta,
    getExportFormat,
    ingestSfeCanonicalSample,
    ingestSfeLifecycle,
    ingestSfeLifecycleFromWirePhase,
    isStaleAttemptMessage,
    MAX_STREAM_PREVIEWS,
    resolveConversationIdForUserAction,
    resolveIsolatedSnapshotData,
    shouldBlockActionsForGeneration,
} from './runner-engine-context';
import { createCleanupRuntime } from './runtime-cleanup';
import {
    createStorageChangeListener as createStorageChangeListenerCore,
    createVisibilityChangeHandler as createVisibilityChangeHandlerCore,
    loadStreamDumpSetting as loadStreamDumpSettingCore,
    loadStreamProbeVisibilitySetting as loadStreamProbeVisibilitySettingCore,
    scheduleButtonInjectionRetries as scheduleButtonInjectionRetriesCore,
} from './runtime-settings';
import {
    getConversationData as getConversationDataCore,
    handleSaveClick as handleSaveClickCore,
} from './save-pipeline';
import { RunnerState } from './state';
import { createStreamDoneCoordinator } from './stream-done-coordinator';

const SFE_STABILIZATION_MAX_WAIT_MS = 3200;
const RUNNER_CONTROL_KEY = '__BLACKIYA_RUNNER_CONTROL__';
type RunnerControl = { cleanup?: () => void };

export const runPlatform = (): void => {
    const globalRunnerControl = (window as unknown as Record<string, unknown>)[RUNNER_CONTROL_KEY] as
        | RunnerControl
        | undefined;
    if (globalRunnerControl?.cleanup) {
        try {
            globalRunnerControl.cleanup();
        } catch (error) {
            logger.debug('Error while cleaning previous runner instance:', error);
        }
    }
    const runnerControl: RunnerControl = {};
    (window as unknown as Record<string, unknown>)[RUNNER_CONTROL_KEY] = runnerControl;

    const sessionToken = generateSessionToken();
    setSessionToken(sessionToken);
    window.postMessage({ type: MESSAGE_TYPES.SESSION_INIT, token: sessionToken }, window.location.origin);

    const runnerState = new RunnerState();
    const sfe = new SignalFusionEngine({
        readinessGate: new ReadinessGate({ maxStabilizationWaitMs: SFE_STABILIZATION_MAX_WAIT_MS }),
    });
    const structuredLogger = new StructuredAttemptLogger();
    const probeLease = new CrossTabProbeLease();

    // Build the shared mutable context
    const ctx: EngineCtx = {
        currentAdapter: null,
        currentConversationId: null,
        lifecycleState: 'idle',
        lifecycleAttemptId: null,
        lifecycleConversationId: null,
        calibrationState: 'idle',
        activeAttemptId: null,
        sfeEnabled: true,
        streamDumpEnabled: false,
        streamProbeVisible: false,
        cleanedUp: false,
        lastResponseFinishedAt: 0,
        lastResponseFinishedConversationId: null,
        lastResponseFinishedAttemptId: null,
        rememberedPreferredStep: null,
        rememberedCalibrationUpdatedAt: null,
        calibrationPreferenceLoaded: false,
        calibrationPreferenceLoading: null,
        lastStreamProbeKey: '',
        lastStreamProbeConversationId: null,
        lastInvalidSessionTokenLogAt: 0,
        lastPendingLifecycleCapacityWarnAt: 0,
        beforeUnloadHandler: null,
        cleanupWindowBridge: null,
        cleanupCompletionWatcher: null,
        cleanupButtonHealthCheck: null,
        lastButtonStateLogRef: { value: '' },
        attemptByConversation: runnerState.attemptByConversation,
        attemptAliasForward: runnerState.attemptAliasForward,
        pendingLifecycleByAttempt: new Map(),
        captureMetaByConversation: runnerState.captureMetaByConversation,
        streamResolvedTitles: new Map(),
        lastCanonicalReadyLogAtByConversation: new Map(),
        timeoutWarningByAttempt: new Set(),
        canonicalStabilizationRetryTimers: new Map(),
        canonicalStabilizationRetryCounts: new Map(),
        canonicalStabilizationStartedAt: new Map(),
        canonicalStabilizationInProgress: new Set(),
        streamProbeControllers: new Map(),
        probeLeaseRetryTimers: new Map(),
        warmFetchInFlight: new Map(),
        autoCaptureAttempts: new Map(),
        autoCaptureRetryTimers: new Map(),
        autoCaptureDeferredLogged: new Set(),
        retryTimeoutIds: [],
        liveStreamPreviewByConversation: runnerState.streamPreviewByConversation,
        sfe,
        probeLease,
        structuredLogger,
        runnerState,
        interceptionManager: null!,
        navigationManager: null!,
        buttonManager: null!,
        streamPreviewState: {
            liveByConversation: runnerState.streamPreviewByConversation,
            liveByAttemptWithoutConversation: new Map(),
            preservedByConversation: new Map(),
            maxEntries: MAX_STREAM_PREVIEWS,
        },
        externalEventDispatchState: createExternalEventDispatcherState(),
        streamProbeRuntime: null,
        // Function stubs — populated below during coordinator wiring
        setCurrentConversation: null!,
        setActiveAttempt: null!,
        bindAttempt: null!,
        resolveAliasedAttemptId: null!,
        peekAttemptId: null!,
        resolveAttemptId: null!,
        isAttemptDisposedOrSuperseded: null!,
        forwardAttemptAlias: null!,
        markSnapshotCaptureMeta: null!,
        markCanonicalCaptureMeta: null!,
        cachePendingLifecycleSignal: null!,
        cancelStreamDoneProbe: null!,
        clearProbeLeaseRetry: null!,
        runStreamDoneProbe: null!,
        clearCanonicalStabilizationRetry: null!,
        hasCanonicalStabilizationTimedOut: null!,
        scheduleCanonicalStabilizationRetry: null!,
        maybeRestartCanonicalRecoveryAfterTimeout: null!,
        ingestSfeLifecycle: null!,
        ingestSfeCanonicalSample: null!,
        logSfeMismatchIfNeeded: null!,
        emitAttemptDisposed: null!,
        evaluateReadinessForData: null!,
        refreshButtonState: null!,
        scheduleButtonRefresh: null!,
        injectSaveButton: null!,
        resolveReadinessDecision: null!,
        isConversationReadyForActions: null!,
        shouldBlockActionsForGeneration: null!,
        isLifecycleActiveGeneration: null!,
        setLifecycleState: null!,
        handleResponseFinished: null!,
        handleSaveClick: null!,
        handleCalibrationClick: null!,
        getConversationData: null!,
        warmFetchConversationSnapshot: null!,
        maybeRunAutoCapture: null!,
        syncCalibrationButtonDisplay: null!,
        ensureCalibrationPreferenceLoaded: null!,
        isCalibrationCaptureSatisfied: null!,
        resetCalibrationPreference: null!,
        handleCalibrationProfilesChanged: null!,
        loadSfeSettings: null!,
        extractConversationIdFromLocation: null!,
        resolveConversationIdForUserAction: null!,
        getCaptureMeta: null!,
        resolveIsolatedSnapshotData: null!,
        setStreamProbePanel: null!,
        withPreservedLiveMirrorSnapshot: null!,
        syncStreamProbePanelFromCanonical: null!,
        appendPendingStreamProbeText: null!,
        migratePendingStreamProbeText: null!,
        appendLiveStreamProbeText: null!,
        isStaleAttemptMessage: null!,
        buildExportPayloadForFormat: null!,
        getExportFormat: null!,
        emitExternalConversationEvent: null!,
        ingestSfeLifecycleFromWirePhase: null!,
        buildCalibrationOrchestrationDeps: null!,
        buildCalibrationCaptureDeps: null!,
        runCalibrationStep: null!,
        buildWarmFetchDeps: null!,
    };

    // ── Wire context-free utility functions ──

    ctx.extractConversationIdFromLocation = () => extractConversationIdFromLocation(ctx);
    ctx.resolveConversationIdForUserAction = () => resolveConversationIdForUserAction(ctx);
    ctx.getCaptureMeta = (cid) => getCaptureMeta(ctx, cid);
    ctx.resolveIsolatedSnapshotData = (cid) => resolveIsolatedSnapshotData(ctx, cid);
    ctx.evaluateReadinessForData = (data) => evaluateReadinessForData(ctx, data);
    ctx.shouldBlockActionsForGeneration = (cid) => shouldBlockActionsForGeneration(ctx, cid);
    ctx.isLifecycleActiveGeneration = () => ctx.lifecycleState === 'prompt-sent' || ctx.lifecycleState === 'streaming';
    ctx.emitAttemptDisposed = (aid, reason) => emitAttemptDisposed(ctx, aid, reason);
    ctx.ingestSfeLifecycle = (phase, aid, cid) => ingestSfeLifecycle(ctx, phase, aid, cid);
    ctx.ingestSfeCanonicalSample = (data, aid) => ingestSfeCanonicalSample(ctx, data, aid);
    ctx.ingestSfeLifecycleFromWirePhase = (phase, aid, cid) => ingestSfeLifecycleFromWirePhase(ctx, phase, aid, cid);
    ctx.isStaleAttemptMessage = (aid, cid, st) => isStaleAttemptMessage(ctx, aid, cid, st);
    ctx.buildExportPayloadForFormat = (data, format) => buildExportPayloadForFormat(ctx, data, format);
    ctx.getExportFormat = getExportFormat;
    ctx.emitExternalConversationEvent = (args) => emitExternalConversationEvent(ctx, args);

    // ── Stream probe runtime ──

    ctx.streamProbeRuntime = createStreamProbeRuntime({
        streamPreviewState: ctx.streamPreviewState,
        isCleanedUp: () => ctx.cleanedUp,
        isStreamProbeVisible: () => ctx.streamProbeVisible,
        getAdapterName: () => ctx.currentAdapter?.name ?? '',
        getHostname: () => window.location?.hostname ?? '',
        getLastStreamProbeConversationId: () => ctx.lastStreamProbeConversationId,
    });
    ctx.setStreamProbePanel = (s, b) => ctx.streamProbeRuntime?.setStreamProbePanel(s, b);
    ctx.withPreservedLiveMirrorSnapshot = (cid, s, b) =>
        ctx.streamProbeRuntime?.withPreservedLiveMirrorSnapshot(cid, s, b) ?? b;
    ctx.syncStreamProbePanelFromCanonical = (cid, data) =>
        ctx.streamProbeRuntime?.syncStreamProbePanelFromCanonical(cid, data);
    ctx.appendPendingStreamProbeText = (aid, text) => ctx.streamProbeRuntime?.appendPendingStreamProbeText(aid, text);
    ctx.migratePendingStreamProbeText = (cid, aid) => ctx.streamProbeRuntime?.migratePendingStreamProbeText(cid, aid);
    ctx.appendLiveStreamProbeText = (cid, text) => ctx.streamProbeRuntime?.appendLiveStreamProbeText(cid, text);

    // ── Attempt coordinator ──

    const attemptCoord = createAttemptCoordinator(buildAttemptCoordinatorDeps(ctx));
    ctx.setCurrentConversation = attemptCoord.setCurrentConversation;
    ctx.setActiveAttempt = attemptCoord.setActiveAttempt;
    ctx.bindAttempt = attemptCoord.bindAttempt;
    ctx.resolveAliasedAttemptId = attemptCoord.resolveAliasedAttemptId;
    ctx.peekAttemptId = attemptCoord.peekAttemptId;
    ctx.resolveAttemptId = attemptCoord.resolveAttemptId;
    ctx.isAttemptDisposedOrSuperseded = attemptCoord.isAttemptDisposedOrSuperseded;
    ctx.forwardAttemptAlias = attemptCoord.forwardAttemptAlias;
    ctx.markSnapshotCaptureMeta = attemptCoord.markSnapshotCaptureMeta;
    ctx.markCanonicalCaptureMeta = attemptCoord.markCanonicalCaptureMeta;
    ctx.cachePendingLifecycleSignal = attemptCoord.cachePendingLifecycleSignal;

    // ── Managers ──

    ctx.buttonManager = new ButtonManager(
        () => ctx.handleSaveClick(),
        () => ctx.handleCalibrationClick(),
    );
    ctx.interceptionManager = new InterceptionManager((capturedId, data, meta) => {
        processInterceptionCaptureCore(capturedId, data, meta, buildInterceptionCaptureDeps(ctx));
    });
    let handleNavigationChange: () => void;
    ctx.navigationManager = new NavigationManager(() => {
        handleNavigationChange();
    });

    // ── Stream done coordinator ──

    const streamDoneCoord = createStreamDoneCoordinator(buildStreamDoneCoordinatorDeps(ctx));
    ctx.cancelStreamDoneProbe = streamDoneCoord.cancelStreamDoneProbe;
    ctx.clearProbeLeaseRetry = streamDoneCoord.clearProbeLeaseRetry;
    ctx.runStreamDoneProbe = streamDoneCoord.runStreamDoneProbe;

    // ── Canonical stabilization ──

    ctx.clearCanonicalStabilizationRetry = (aid) =>
        clearCanonicalStabilizationRetryCore(aid, buildCanonicalStabilizationTickDeps(ctx));
    ctx.hasCanonicalStabilizationTimedOut = (aid) =>
        hasCanonicalStabilizationTimedOutCore(aid, buildCanonicalStabilizationTickDeps(ctx));
    ctx.scheduleCanonicalStabilizationRetry = (cid, aid) =>
        scheduleCanonicalStabilizationRetryCore(cid, aid, buildCanonicalStabilizationTickDeps(ctx));
    ctx.maybeRestartCanonicalRecoveryAfterTimeout = (cid, aid) =>
        maybeRestartCanonicalRecoveryAfterTimeoutCore(cid, aid, buildCanonicalStabilizationTickDeps(ctx));

    // ── Save pipeline ──

    ctx.handleSaveClick = async () => handleSaveClickCore(buildSavePipelineDeps(ctx));
    ctx.getConversationData = (opts = {}) => getConversationDataCore(opts, buildSavePipelineDeps(ctx));

    // ── Calibration runtime ──

    ctx.buildWarmFetchDeps = () => buildWarmFetchDeps(ctx);
    ctx.buildCalibrationCaptureDeps = (cid) => buildCalibrationCaptureDeps(ctx, cid);
    ctx.runCalibrationStep = (step, cid, mode) =>
        runCalibrationStepPure(step, cid, mode, buildCalibrationCaptureDeps(ctx, cid));
    const calibrationRuntime = createCalibrationRuntime(buildCalibrationRuntimeDeps(ctx));
    ctx.buildCalibrationOrchestrationDeps = calibrationRuntime.buildCalibrationOrchestrationDeps;
    ctx.loadSfeSettings = calibrationRuntime.loadSfeSettings;
    ctx.ensureCalibrationPreferenceLoaded = calibrationRuntime.ensureCalibrationPreferenceLoaded;
    ctx.syncCalibrationButtonDisplay = calibrationRuntime.syncCalibrationButtonDisplay;
    ctx.isCalibrationCaptureSatisfied = calibrationRuntime.isCalibrationCaptureSatisfied;
    ctx.maybeRunAutoCapture = calibrationRuntime.maybeRunAutoCapture;
    ctx.warmFetchConversationSnapshot = calibrationRuntime.warmFetchConversationSnapshot;
    ctx.resetCalibrationPreference = calibrationRuntime.resetCalibrationPreference;
    ctx.handleCalibrationProfilesChanged = calibrationRuntime.handleCalibrationProfilesChanged;
    ctx.handleCalibrationClick = async () => handleCalibrationClickCore(ctx.buildCalibrationOrchestrationDeps());

    // ── Button state ──

    ctx.injectSaveButton = () => injectSaveButtonCore(buildButtonStateManagerDeps(ctx), ctx.lastButtonStateLogRef);
    ctx.resolveReadinessDecision = (cid) => resolveReadinessDecisionCore(cid, buildButtonStateManagerDeps(ctx));
    ctx.isConversationReadyForActions = (cid, opts = {}) =>
        isConversationReadyForActionsCore(cid, opts, buildButtonStateManagerDeps(ctx));
    ctx.refreshButtonState = (cid) =>
        refreshButtonStateCore(cid, buildButtonStateManagerDeps(ctx), ctx.lastButtonStateLogRef);
    ctx.scheduleButtonRefresh = (cid) =>
        scheduleButtonRefreshCore(cid, buildButtonStateManagerDeps(ctx), ctx.lastButtonStateLogRef);

    const syncLifecycleConversationBinding = (state: string, resolvedCid: string | null) => {
        if (state === 'idle') {
            ctx.lifecycleConversationId = null;
            ctx.lifecycleAttemptId = null;
            return;
        }
        if (resolvedCid) {
            ctx.lifecycleConversationId = resolvedCid;
        }
    };

    const applyLifecycleUiState = (state: string, conversationId?: string) => {
        if (state === 'completed') {
            const targetId = conversationId || ctx.extractConversationIdFromLocation() || undefined;
            if (targetId) {
                ctx.refreshButtonState(targetId);
                ctx.scheduleButtonRefresh(targetId);
            }
            return;
        }
        if (state === 'prompt-sent' || state === 'streaming') {
            ctx.buttonManager.setActionButtonsEnabled(false);
            ctx.buttonManager.setOpacity('0.6');
        }
    };

    // ── Lifecycle state ──

    ctx.setLifecycleState = (state, conversationId) => {
        const resolvedCid = conversationId ?? ctx.currentConversationId ?? null;
        if (ctx.lifecycleState !== state) {
            logger.info('Lifecycle transition', { from: ctx.lifecycleState, to: state, conversationId: resolvedCid });
        }
        ctx.lifecycleState = state;
        ctx.runnerState.lifecycleState = state;
        syncLifecycleConversationBinding(state, resolvedCid);
        ctx.buttonManager.setLifecycleState(state);
        applyLifecycleUiState(state, conversationId);
    };

    // ── Response finished ──

    ctx.handleResponseFinished = (source, hintedCid) =>
        processResponseFinishedCore(source, hintedCid, buildResponseFinishedDeps(ctx));

    // ── Runtime wiring ──

    const runtimeWiring = createRuntimeWiring(buildRuntimeWiringDeps(ctx));
    handleNavigationChange = runtimeWiring.handleNavigationChange;

    // ── Boot sequence ──

    const url = window.location.href;
    ctx.currentAdapter = getPlatformAdapter(url);
    ctx.runnerState.adapter = ctx.currentAdapter;

    if (!ctx.currentAdapter) {
        logger.warn('No matching platform adapter for this URL');
        return;
    }

    logger.info(`Content script running for ${ctx.currentAdapter.name}`);
    logger.info('Runner init', { platform: ctx.currentAdapter.name, url });

    ctx.interceptionManager.updateAdapter(ctx.currentAdapter);
    void ctx.ensureCalibrationPreferenceLoaded(ctx.currentAdapter.name);
    void ctx.loadSfeSettings();
    void loadStreamDumpSettingCore(buildStreamDumpSettingDeps(ctx));
    void loadStreamProbeVisibilitySettingCore(buildStreamProbeVisibilitySettingDeps(ctx));

    const storageChangeListener = createStorageChangeListenerCore(buildStorageChangeListenerDeps(ctx));
    browser.storage.onChanged.addListener(storageChangeListener);

    ctx.interceptionManager.start();
    ctx.navigationManager.start();
    ctx.cleanupWindowBridge = runtimeWiring.registerWindowBridge();
    ctx.cleanupCompletionWatcher = runtimeWiring.registerCompletionWatcher();
    ctx.cleanupButtonHealthCheck = runtimeWiring.registerButtonHealthCheck();

    const handleVisibilityChange = createVisibilityChangeHandlerCore(buildVisibilityRecoveryDeps(ctx));
    document.addEventListener('visibilitychange', handleVisibilityChange);

    ctx.setCurrentConversation(ctx.currentAdapter.extractConversationId(url));
    ctx.injectSaveButton();
    if (ctx.currentConversationId) {
        void ctx.warmFetchConversationSnapshot(ctx.currentConversationId, 'initial-load');
    }
    ctx.retryTimeoutIds.push(
        ...scheduleButtonInjectionRetriesCore(ctx.injectSaveButton, () => ctx.buttonManager.exists()),
    );

    // ── Cleanup ──

    const cleanupDeps = buildCleanupRuntimeDeps(ctx, runnerControl, storageChangeListener);
    cleanupDeps.removeVisibilityChangeListener = () =>
        document.removeEventListener('visibilitychange', handleVisibilityChange);
    cleanupDeps.removeStorageChangeListener = () => browser.storage.onChanged.removeListener(storageChangeListener);
    cleanupDeps.cleanupWindowBridge = ctx.cleanupWindowBridge;
    cleanupDeps.cleanupCompletionWatcher = ctx.cleanupCompletionWatcher;
    cleanupDeps.cleanupButtonHealthCheck = ctx.cleanupButtonHealthCheck;
    const cleanupRuntime = createCleanupRuntime(cleanupDeps);

    ctx.beforeUnloadHandler = cleanupRuntime;
    window.addEventListener('beforeunload', cleanupRuntime);
    runnerControl.cleanup = cleanupRuntime;
};
