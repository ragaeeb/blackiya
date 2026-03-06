/**
 * Platform Runner Engine
 *
 * Thin orchestrator that creates the engine context, wires coordinators,
 * and drives the boot/cleanup lifecycle. Deps wiring lives in
 * runner-engine-context.ts, while shared engine utilities/types are split
 * into dedicated runner-engine-* modules.
 *
 * @module utils/runner/platform-runner-engine
 */

import { browser } from 'wxt/browser';
import { getPlatformAdapter } from '@/platforms/factory';
import { getBuildFingerprint } from '@/utils/build-fingerprint';
import { logger } from '@/utils/logger';
import { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import { InterceptionManager } from '@/utils/managers/interception-manager';
import { NavigationManager } from '@/utils/managers/navigation-manager';
import { readPlatformHeadersFromCache, writePlatformHeadersToCache } from '@/utils/platform-header-cache';
import { platformHeaderStore } from '@/utils/platform-header-store';
import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import { generateSessionToken, setSessionToken } from '@/utils/protocol/session-token';
import { createAttemptCoordinator } from '@/utils/runner/attempt-coordinator';
import { runBulkChatExport } from '@/utils/runner/bulk-chat-export';
import {
    BULK_EXPORT_PROGRESS_MESSAGE,
    type BulkExportChatsResponse,
    isBulkExportChatsMessage,
} from '@/utils/runner/bulk-chat-export-contract';
import {
    injectSaveButton as injectSaveButtonCore,
    isConversationReadyForActions as isConversationReadyForActionsCore,
    refreshButtonState as refreshButtonStateCore,
    resolveReadinessDecision as resolveReadinessDecisionCore,
    scheduleButtonRefresh as scheduleButtonRefreshCore,
} from '@/utils/runner/button-state-manager';
import { runCalibrationStep as runCalibrationStepPure } from '@/utils/runner/calibration-capture';
import { handleCalibrationClick as handleCalibrationClickCore } from '@/utils/runner/calibration-orchestration';
import {
    clearCanonicalStabilizationRetry as clearCanonicalStabilizationRetryCore,
    hasCanonicalStabilizationTimedOut as hasCanonicalStabilizationTimedOutCore,
    maybeRestartCanonicalRecoveryAfterTimeout as maybeRestartCanonicalRecoveryAfterTimeoutCore,
    scheduleCanonicalStabilizationRetry as scheduleCanonicalStabilizationRetryCore,
} from '@/utils/runner/canonical-stabilization-tick';
import {
    buildAttemptCoordinatorDeps,
    buildButtonStateManagerDeps,
    buildCalibrationCaptureDeps,
    buildCalibrationRuntimeDeps,
    buildCanonicalStabilizationTickDeps,
    buildCleanupRuntimeDeps,
    buildInterceptionCaptureDeps,
    buildResponseFinishedDeps,
    buildRuntimeWiringDeps,
    buildSavePipelineDeps,
    buildStorageChangeListenerDeps,
    buildStreamDoneCoordinatorDeps,
    buildStreamProbeVisibilitySettingDeps,
    buildVisibilityRecoveryDeps,
    buildWarmFetchDeps,
} from '@/utils/runner/engine/context';
import {
    evaluateReadinessForData,
    extractConversationIdFromLocation,
    getCaptureMeta,
    resolveConversationIdForUserAction,
    resolveIsolatedSnapshotData,
    shouldBlockActionsForGeneration,
} from '@/utils/runner/engine/core-utils';
import {
    emitAttemptDisposed,
    ingestSfeCanonicalSample,
    ingestSfeLifecycle,
    ingestSfeLifecycleFromWirePhase,
    isStaleAttemptMessage,
} from '@/utils/runner/engine/sfe-wrappers';
import type { EngineCtx } from '@/utils/runner/engine/types';
import { MAX_STREAM_PREVIEWS } from '@/utils/runner/engine/types';
import { createExternalEventDispatcherState } from '@/utils/runner/external-event-dispatch';
import { requestGeminiBatchexecuteContextFromMainWorld } from '@/utils/runner/gemini-batchexecute-request';
import { processInterceptionCapture as processInterceptionCaptureCore } from '@/utils/runner/interception-capture';
import { requestPlatformHeadersFromMainWorld } from '@/utils/runner/platform-header-request';
import { processResponseFinished as processResponseFinishedCore } from '@/utils/runner/response-finished-handler';
import { createCalibrationRuntime } from '@/utils/runner/runtime/platform-runtime-calibration';
import { createStreamProbeRuntime } from '@/utils/runner/runtime/platform-runtime-stream-probe';
import { createRuntimeWiring } from '@/utils/runner/runtime/platform-runtime-wiring';
import { createCleanupRuntime } from '@/utils/runner/runtime/runtime-cleanup';
import {
    createStorageChangeListener as createStorageChangeListenerCore,
    createVisibilityChangeHandler as createVisibilityChangeHandlerCore,
    loadStreamProbeVisibilitySetting as loadStreamProbeVisibilitySettingCore,
    scheduleButtonInjectionRetries as scheduleButtonInjectionRetriesCore,
} from '@/utils/runner/runtime/runtime-settings';
import {
    getConversationData as getConversationDataCore,
    handleSaveClick as handleSaveClickCore,
} from '@/utils/runner/save-pipeline';
import { RunnerState } from '@/utils/runner/state';
import { createStreamDoneCoordinator } from '@/utils/runner/stream/stream-done-coordinator';
import { CrossTabProbeLease } from '@/utils/sfe/cross-tab-probe-lease';
import { ReadinessGate } from '@/utils/sfe/readiness-gate';
import { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';
import { ButtonManager } from '@/utils/ui/button-manager';

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
        cleanupRuntimeMessageListener: null,
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
        emitExternalConversationEvent: null!,
        ingestSfeLifecycleFromWirePhase: null!,
        buildCalibrationOrchestrationDeps: null!,
        buildCalibrationCaptureDeps: null!,
        runCalibrationStep: null!,
        buildWarmFetchDeps: null!,
    };

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
    ctx.emitExternalConversationEvent = () => {};

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

    const streamDoneCoord = createStreamDoneCoordinator(buildStreamDoneCoordinatorDeps(ctx));
    ctx.cancelStreamDoneProbe = streamDoneCoord.cancelStreamDoneProbe;
    ctx.clearProbeLeaseRetry = streamDoneCoord.clearProbeLeaseRetry;
    ctx.runStreamDoneProbe = (conversationId, attemptId) =>
        streamDoneCoord.runStreamDoneProbe(conversationId, attemptId);

    ctx.clearCanonicalStabilizationRetry = (aid) =>
        clearCanonicalStabilizationRetryCore(aid, buildCanonicalStabilizationTickDeps(ctx));
    ctx.hasCanonicalStabilizationTimedOut = (aid) =>
        hasCanonicalStabilizationTimedOutCore(aid, buildCanonicalStabilizationTickDeps(ctx));
    ctx.scheduleCanonicalStabilizationRetry = (cid, aid) =>
        scheduleCanonicalStabilizationRetryCore(cid, aid, buildCanonicalStabilizationTickDeps(ctx));
    ctx.maybeRestartCanonicalRecoveryAfterTimeout = (cid, aid) =>
        maybeRestartCanonicalRecoveryAfterTimeoutCore(cid, aid, buildCanonicalStabilizationTickDeps(ctx));

    ctx.handleSaveClick = async () => handleSaveClickCore(buildSavePipelineDeps(ctx));
    ctx.getConversationData = (opts = {}) => getConversationDataCore(opts, buildSavePipelineDeps(ctx));

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

    ctx.handleResponseFinished = (source, hintedCid) =>
        processResponseFinishedCore(source, hintedCid, buildResponseFinishedDeps(ctx));

    const runtimeWiring = createRuntimeWiring(buildRuntimeWiringDeps(ctx));
    handleNavigationChange = runtimeWiring.handleNavigationChange;

    const url = window.location.href;
    ctx.currentAdapter = getPlatformAdapter(url);
    ctx.runnerState.adapter = ctx.currentAdapter;

    if (!ctx.currentAdapter) {
        logger.warn('No matching platform adapter for this URL');
        return;
    }

    logger.info(`Content script running for ${ctx.currentAdapter.name}`);
    logger.info('Runner init', {
        platform: ctx.currentAdapter.name,
        url,
        build: getBuildFingerprint(),
    });

    void readPlatformHeadersFromCache(ctx.currentAdapter.name).then((cachedHeaders) => {
        if (cachedHeaders) {
            platformHeaderStore.update(ctx.currentAdapter?.name ?? '', cachedHeaders);
        }
    });

    ctx.interceptionManager.updateAdapter(ctx.currentAdapter);
    void ctx.ensureCalibrationPreferenceLoaded(ctx.currentAdapter.name);
    void ctx.loadSfeSettings();
    void loadStreamProbeVisibilitySettingCore(buildStreamProbeVisibilitySettingDeps(ctx));

    const storageChangeListener = createStorageChangeListenerCore(buildStorageChangeListenerDeps(ctx));
    browser.storage.onChanged.addListener(storageChangeListener);

    ctx.interceptionManager.start();
    ctx.navigationManager.start();
    ctx.cleanupWindowBridge = runtimeWiring.registerWindowBridge();
    ctx.cleanupCompletionWatcher = runtimeWiring.registerCompletionWatcher();
    ctx.cleanupButtonHealthCheck = runtimeWiring.registerButtonHealthCheck();

    const resolveBulkExportRuntimeContext = async (platformName: string) => {
        const cachedHeaders = await readPlatformHeadersFromCache(platformName);
        const localHeaders = platformHeaderStore.get(platformName);
        const bridgedHeaders = await requestPlatformHeadersFromMainWorld(platformName);
        const mergedHeaders = {
            ...(cachedHeaders ?? {}),
            ...(localHeaders ?? {}),
            ...(bridgedHeaders ?? {}),
        };
        const resolvedHeaders = Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;
        if (resolvedHeaders) {
            void writePlatformHeadersToCache(platformName, resolvedHeaders);
            platformHeaderStore.update(platformName, resolvedHeaders);
        }
        const geminiBatchexecuteContext =
            platformName === 'Gemini' ? await requestGeminiBatchexecuteContextFromMainWorld() : undefined;
        if (
            platformName === 'ChatGPT' &&
            (!resolvedHeaders ||
                typeof resolvedHeaders.authorization !== 'string' ||
                resolvedHeaders.authorization.length === 0)
        ) {
            throw new Error(
                'Missing ChatGPT auth headers. Trigger one normal ChatGPT request in this tab, then retry Export Chats.',
            );
        }
        return {
            resolvedHeaders,
            geminiBatchexecuteContext,
        };
    };

    const runtimeMessageListener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
        message,
        _sender,
        sendResponse,
    ) => {
        if (isBulkExportChatsMessage(message)) {
            const platformName = ctx.currentAdapter?.name ?? '';
            void Promise.resolve()
                .then(() => resolveBulkExportRuntimeContext(platformName))
                .then(({ resolvedHeaders, geminiBatchexecuteContext }) =>
                    runBulkChatExport(message, {
                        getAdapter: () => ctx.currentAdapter,
                        getAuthHeaders: () => resolvedHeaders,
                        getGeminiBatchexecuteContext: () => geminiBatchexecuteContext,
                        locationHref: () => window.location.href,
                        onProgress: (progress) => {
                            void browser.runtime.sendMessage({
                                ...progress,
                                type: BULK_EXPORT_PROGRESS_MESSAGE,
                            });
                        },
                    }),
                )
                .then((result) => {
                    logger.info('Bulk chat export completed', result);
                    sendResponse({
                        ok: true,
                        result,
                    } satisfies BulkExportChatsResponse);
                })
                .catch((error) => {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    void browser.runtime.sendMessage({
                        type: BULK_EXPORT_PROGRESS_MESSAGE,
                        stage: 'failed',
                        platform: platformName,
                        message: errorMessage,
                    });
                    logger.warn('Bulk chat export failed', { error: errorMessage });
                    sendResponse({
                        ok: false,
                        error: errorMessage,
                    } satisfies BulkExportChatsResponse);
                });
            return true;
        }

        return;
    };
    if (browser.runtime?.onMessage?.addListener) {
        browser.runtime.onMessage.addListener(runtimeMessageListener);
        ctx.cleanupRuntimeMessageListener = () => {
            browser.runtime.onMessage.removeListener?.(runtimeMessageListener);
        };
    } else {
        ctx.cleanupRuntimeMessageListener = null;
    }

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

    const cleanupDeps = buildCleanupRuntimeDeps(ctx, runnerControl, storageChangeListener);
    cleanupDeps.removeVisibilityChangeListener = () =>
        document.removeEventListener('visibilitychange', handleVisibilityChange);
    cleanupDeps.removeStorageChangeListener = () => browser.storage.onChanged.removeListener(storageChangeListener);
    cleanupDeps.cleanupWindowBridge = ctx.cleanupWindowBridge;
    cleanupDeps.cleanupCompletionWatcher = ctx.cleanupCompletionWatcher;
    cleanupDeps.cleanupButtonHealthCheck = ctx.cleanupButtonHealthCheck;
    cleanupDeps.cleanupRuntimeMessageListener = ctx.cleanupRuntimeMessageListener;
    const cleanupRuntime = createCleanupRuntime(cleanupDeps);

    ctx.beforeUnloadHandler = cleanupRuntime;
    window.addEventListener('beforeunload', cleanupRuntime);
    runnerControl.cleanup = cleanupRuntime;
};
