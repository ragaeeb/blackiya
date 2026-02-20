/**
 * Platform Runner Utility
 *
 * Orchestrator that ties together the specialised managers for:
 * - UI (ButtonManager)
 * - Data (InterceptionManager)
 * - Navigation (NavigationManager)
 *
 * @module utils/platform-runner
 */

import { browser } from 'wxt/browser';
import { getPlatformAdapter } from '@/platforms/factory';
import type { LLMPlatform } from '@/platforms/types';
import { logger } from '@/utils/logger';
import { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import { InterceptionManager } from '@/utils/managers/interception-manager';
import { NavigationManager } from '@/utils/managers/navigation-manager';
import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import type {
    AttemptDisposedMessage,
    ResponseLifecycleMessage,
    StreamDumpConfigMessage,
} from '@/utils/protocol/messages';
import { generateSessionToken, setSessionToken, stampToken } from '@/utils/protocol/session-token';
import { createAttemptCoordinator } from '@/utils/runner/attempt-coordinator';
import { shouldRemoveDisposedAttemptBinding as shouldRemoveDisposedAttemptBindingFromRegistry } from '@/utils/runner/attempt-state';
import {
    type ButtonStateManagerDeps,
    injectSaveButton as injectSaveButtonCore,
    isConversationReadyForActions as isConversationReadyForActionsCore,
    refreshButtonState as refreshButtonStateCore,
    resolveReadinessDecision as resolveReadinessDecisionCore,
    scheduleButtonRefresh as scheduleButtonRefreshCore,
} from '@/utils/runner/button-state-manager';
import {
    type CalibrationCaptureDeps,
    isConversationDataLike,
    runCalibrationStep as runCalibrationStepPure,
} from '@/utils/runner/calibration-capture';
import { handleCalibrationClick as handleCalibrationClickCore } from '@/utils/runner/calibration-orchestration';
import {
    buildCalibrationOrderForMode,
    type CalibrationMode,
    shouldPersistCalibrationProfile,
} from '@/utils/runner/calibration-policy';
import type { CalibrationStep } from '@/utils/runner/calibration-runner';
import {
    beginCanonicalStabilizationTick,
    type CanonicalStabilizationAttemptState,
    clearCanonicalStabilizationAttemptState,
    resolveShouldSkipCanonicalRetryAfterAwait,
} from '@/utils/runner/canonical-stabilization';
import {
    type CanonicalStabilizationTickDeps,
    clearCanonicalStabilizationRetry as clearCanonicalStabilizationRetryCore,
    hasCanonicalStabilizationTimedOut as hasCanonicalStabilizationTimedOutCore,
    maybeRestartCanonicalRecoveryAfterTimeout as maybeRestartCanonicalRecoveryAfterTimeoutCore,
    scheduleCanonicalStabilizationRetry as scheduleCanonicalStabilizationRetryCore,
} from '@/utils/runner/canonical-stabilization-tick';
import { buildIsolatedDomSnapshot } from '@/utils/runner/dom-snapshot';
import {
    buildExportPayloadForFormat as buildExportPayloadForFormatPure,
    extractResponseTextFromConversation,
} from '@/utils/runner/export-helpers';
import { detectPlatformGenerating } from '@/utils/runner/generation-guard';
import {
    type InterceptionCaptureDeps,
    processInterceptionCapture as processInterceptionCaptureCore,
} from '@/utils/runner/interception-capture';
import { requestPageSnapshot } from '@/utils/runner/page-snapshot-bridge';
import { createCalibrationRuntime } from '@/utils/runner/platform-runtime-calibration';
import { createStreamProbeRuntime } from '@/utils/runner/platform-runtime-stream-probe';
import { createRuntimeWiring } from '@/utils/runner/platform-runtime-wiring';
import { removeStreamProbePanel } from '@/utils/runner/probe-panel';
import {
    emitPublicStatusSnapshot as emitPublicStatusSnapshotCore,
    type PublicStatusDeps,
    type PublicStatusState,
} from '@/utils/runner/public-status';
import { evaluateReadinessForData as evaluateReadinessForDataPure } from '@/utils/runner/readiness-evaluation';
import type { ResponseFinishedDeps } from '@/utils/runner/response-finished-handler';
import { processResponseFinished as processResponseFinishedCore } from '@/utils/runner/response-finished-handler';
import { createCleanupRuntime, type RunnerCleanupDeps } from '@/utils/runner/runtime-cleanup';
import {
    createStorageChangeListener as createStorageChangeListenerCore,
    createVisibilityChangeHandler as createVisibilityChangeHandlerCore,
    getExportFormat as getExportFormatCore,
    loadStreamDumpSetting as loadStreamDumpSettingCore,
    loadStreamProbeVisibilitySetting as loadStreamProbeVisibilitySettingCore,
    type StorageChangeListenerDeps,
    type StreamDumpSettingDeps,
    type StreamProbeVisibilitySettingDeps,
    scheduleButtonInjectionRetries as scheduleButtonInjectionRetriesCore,
    type VisibilityRecoveryDeps,
} from '@/utils/runner/runtime-settings';
import {
    getConversationData as getConversationDataCore,
    handleSaveClick as handleSaveClickCore,
    type SavePipelineDeps,
} from '@/utils/runner/save-pipeline';
import type { SfeIngestionDeps } from '@/utils/runner/sfe-ingestion';
import {
    emitAttemptDisposed as emitAttemptDisposedCore,
    ingestSfeCanonicalSample as ingestSfeCanonicalSampleCore,
    ingestSfeLifecycleFromWirePhase as ingestSfeLifecycleFromWirePhaseCore,
    ingestSfeLifecycleSignal as ingestSfeLifecycleSignalCore,
    logSfeMismatchIfNeeded as logSfeMismatchIfNeededCore,
} from '@/utils/runner/sfe-ingestion';
import {
    isStaleAttemptMessage as isStaleAttemptMessageCore,
    type StaleAttemptFilterDeps,
} from '@/utils/runner/stale-attempt-filter';
import { RunnerState } from '@/utils/runner/state';
import { createStreamDoneCoordinator } from '@/utils/runner/stream-done-coordinator';
import type { RunnerStreamPreviewState } from '@/utils/runner/stream-preview';
import { getFetchUrlCandidates, getRawSnapshotReplayUrls } from '@/utils/runner/url-candidates';
import type { WarmFetchDeps } from '@/utils/runner/warm-fetch';
import { DEFAULT_EXPORT_FORMAT, type ExportFormat } from '@/utils/settings';
import { shouldIngestAsCanonicalSample } from '@/utils/sfe/capture-fidelity';
import { CrossTabProbeLease } from '@/utils/sfe/cross-tab-probe-lease';
import { ReadinessGate } from '@/utils/sfe/readiness-gate';
import { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';
import type { ExportMeta, LifecyclePhase, PlatformReadiness, ReadinessDecision } from '@/utils/sfe/types';
import { resolveExportConversationTitleDecision as resolveExportTitleDecision } from '@/utils/title-resolver';
import type { ConversationData } from '@/utils/types';
import { ButtonManager } from '@/utils/ui/button-manager';

// Local types

type LifecycleUiState = 'idle' | 'prompt-sent' | 'streaming' | 'completed';
type CalibrationUiState = 'idle' | 'waiting' | 'capturing' | 'success' | 'error';

// Constants

const CANONICAL_STABILIZATION_RETRY_DELAY_MS = 1150;
const CANONICAL_STABILIZATION_MAX_RETRIES = 6;
const CANONICAL_STABILIZATION_TIMEOUT_GRACE_MS = 400;
const SFE_STABILIZATION_MAX_WAIT_MS = 3200;
const PROBE_LEASE_TTL_MS = 5000;
const PROBE_LEASE_RETRY_GRACE_MS = 500;
const MAX_CONVERSATION_ATTEMPTS = 250;
const MAX_PENDING_LIFECYCLE_ATTEMPTS = 320;
const MAX_STREAM_PREVIEWS = 150;
const MAX_AUTOCAPTURE_KEYS = 400;
const MAX_STREAM_RESOLVED_TITLES = MAX_CONVERSATION_ATTEMPTS;
const CANONICAL_READY_LOG_TTL_MS = 15_000;
const RUNNER_CONTROL_KEY = '__BLACKIYA_RUNNER_CONTROL__';

type RunnerControl = { cleanup?: () => void };

// Public re-exports (consumed by platform-runner.ts compat shim)

export { beginCanonicalStabilizationTick, clearCanonicalStabilizationAttemptState };
export type { CanonicalStabilizationAttemptState };
export { buildCalibrationOrderForMode, shouldPersistCalibrationProfile };

export const resolveExportConversationTitle = (data: ConversationData) => resolveExportTitleDecision(data).title;

export const shouldRemoveDisposedAttemptBinding = (
    mappedAttemptId: string,
    disposedAttemptId: string,
    resolveAttemptId: (attemptId: string) => string,
) => shouldRemoveDisposedAttemptBindingFromRegistry(mappedAttemptId, disposedAttemptId, resolveAttemptId);

export { resolveShouldSkipCanonicalRetryAfterAwait };

// Main runner

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

    let currentAdapter: LLMPlatform | null = null;
    let currentConversationId: string | null = null;
    let cleanupWindowBridge: (() => void) | null = null;
    let cleanupCompletionWatcher: (() => void) | null = null;
    let cleanupButtonHealthCheck: (() => void) | null = null;
    const retryTimeoutIds: number[] = [];
    let calibrationState: CalibrationUiState = 'idle';
    let lifecycleState: LifecycleUiState = 'idle';
    let lifecycleAttemptId: string | null = null;
    let lifecycleConversationId: string | null = null;
    let lastStreamProbeKey = '';
    let lastStreamProbeConversationId: string | null = null;
    const liveStreamPreviewByConversation = runnerState.streamPreviewByConversation;
    const liveStreamPreviewByAttemptWithoutConversation = new Map<string, string>();
    const preservedLiveStreamSnapshotByConversation = new Map<string, string>();
    const streamPreviewState: RunnerStreamPreviewState = {
        liveByConversation: liveStreamPreviewByConversation,
        liveByAttemptWithoutConversation: liveStreamPreviewByAttemptWithoutConversation,
        preservedByConversation: preservedLiveStreamSnapshotByConversation,
        maxEntries: MAX_STREAM_PREVIEWS,
    };
    let streamDumpEnabled = false;
    let streamProbeVisible = false;
    const streamProbeControllers = new Map<string, AbortController>();
    const probeLeaseRetryTimers = new Map<string, number>();
    const canonicalStabilizationRetryTimers = new Map<string, number>();
    const canonicalStabilizationRetryCounts = new Map<string, number>();
    const canonicalStabilizationStartedAt = new Map<string, number>();
    const timeoutWarningByAttempt = new Set<string>();
    const canonicalStabilizationInProgress = new Set<string>();
    let lastResponseFinishedAt = 0;
    let lastResponseFinishedConversationId: string | null = null;
    let lastResponseFinishedAttemptId: string | null = null;
    let lastPendingLifecycleCapacityWarnAt = 0;
    let rememberedPreferredStep: CalibrationStep | null = null;
    let rememberedCalibrationUpdatedAt: string | null = null;
    let calibrationPreferenceLoaded = false;
    let calibrationPreferenceLoading: Promise<void> | null = null;
    let sfeEnabled = true;
    const autoCaptureAttempts = new Map<string, number>();
    const autoCaptureRetryTimers = new Map<string, number>();
    const autoCaptureDeferredLogged = new Set<string>();
    const warmFetchInFlight = new Map<string, Promise<boolean>>();
    const sfe = new SignalFusionEngine({
        readinessGate: new ReadinessGate({ maxStabilizationWaitMs: SFE_STABILIZATION_MAX_WAIT_MS }),
    });
    const structuredLogger = new StructuredAttemptLogger();
    const attemptByConversation = runnerState.attemptByConversation;
    const attemptAliasForward = runnerState.attemptAliasForward;
    const pendingLifecycleByAttempt = new Map<
        string,
        { phase: ResponseLifecycleMessage['phase']; platform: string; receivedAtMs: number }
    >();
    const captureMetaByConversation = runnerState.captureMetaByConversation;
    const probeLease = new CrossTabProbeLease();
    const streamResolvedTitles = new Map<string, string>();
    const lastCanonicalReadyLogAtByConversation = new Map<string, number>();
    let activeAttemptId: string | null = null;
    let lastInvalidSessionTokenLogAt = 0;
    let cleanedUp = false;
    let beforeUnloadHandler: (() => void) | null = null;
    let streamProbeRuntime: ReturnType<typeof createStreamProbeRuntime> | null = null;

    function setStreamProbePanel(status: string, body: string) {
        streamProbeRuntime?.setStreamProbePanel(status, body);
    }

    function withPreservedLiveMirrorSnapshot(conversationId: string, status: string, primaryBody: string): string {
        return streamProbeRuntime?.withPreservedLiveMirrorSnapshot(conversationId, status, primaryBody) ?? primaryBody;
    }

    function syncStreamProbePanelFromCanonical(conversationId: string, data: ConversationData) {
        streamProbeRuntime?.syncStreamProbePanelFromCanonical(conversationId, data);
    }

    function appendPendingStreamProbeText(canonicalAttemptId: string, text: string) {
        streamProbeRuntime?.appendPendingStreamProbeText(canonicalAttemptId, text);
    }

    function migratePendingStreamProbeText(conversationId: string, canonicalAttemptId: string) {
        streamProbeRuntime?.migratePendingStreamProbeText(conversationId, canonicalAttemptId);
    }

    function appendLiveStreamProbeText(conversationId: string, text: string) {
        streamProbeRuntime?.appendLiveStreamProbeText(conversationId, text);
    }

    // Public status — delegates to public-status module

    const publicStatusState: PublicStatusState = { sequence: 0, lastSignature: '' };

    const resolveLocationConversationId = () => {
        if (!currentAdapter) {
            return null;
        }
        try {
            return currentAdapter.extractConversationId(window.location.href);
        } catch {
            return null;
        }
    };

    const buildPublicStatusDeps = (): PublicStatusDeps => ({
        getCurrentConversationId: () => currentConversationId,
        resolveLocationConversationId,
        peekAttemptId,
        getActiveAttemptId: () => activeAttemptId,
        getAdapterName: () => currentAdapter?.name ?? null,
        getLifecycleState: () => lifecycleState,
        resolveReadinessDecision,
        shouldBlockActionsForGeneration,
        hasAdapter: () => !!currentAdapter,
    });

    const emitPublicStatusSnapshot = (conversationIdOverride?: string | null) =>
        emitPublicStatusSnapshotCore(conversationIdOverride, publicStatusState, buildPublicStatusDeps());

    const {
        setCurrentConversation,
        setActiveAttempt,
        cachePendingLifecycleSignal,
        markSnapshotCaptureMeta,
        markCanonicalCaptureMeta,
        resolveAliasedAttemptId,
        forwardAttemptAlias,
        peekAttemptId,
        resolveAttemptId,
        bindAttempt,
        isAttemptDisposedOrSuperseded,
    } = createAttemptCoordinator({
        maxConversationAttempts: MAX_CONVERSATION_ATTEMPTS,
        maxPendingLifecycleAttempts: MAX_PENDING_LIFECYCLE_ATTEMPTS,
        attemptByConversation,
        attemptAliasForward,
        pendingLifecycleByAttempt,
        captureMetaByConversation,
        getCurrentConversationId: () => currentConversationId,
        setCurrentConversationId: (conversationId) => {
            currentConversationId = conversationId;
        },
        getActiveAttemptId: () => activeAttemptId,
        setActiveAttemptId: (attemptId) => {
            activeAttemptId = attemptId;
        },
        setRunnerConversationId: (conversationId) => {
            runnerState.conversationId = conversationId;
        },
        setRunnerActiveAttemptId: (attemptId) => {
            runnerState.activeAttemptId = attemptId;
        },
        emitPublicStatusSnapshot,
        getAdapterName: () => currentAdapter?.name,
        sfe,
        cancelStreamDoneProbe: (attemptId, reason) => {
            cancelStreamDoneProbe(attemptId, reason);
        },
        clearCanonicalStabilizationRetry: (attemptId) => {
            clearCanonicalStabilizationRetry(attemptId);
        },
        clearProbeLeaseRetry: (attemptId) => {
            clearProbeLeaseRetry(attemptId);
        },
        emitAttemptDisposed: (attemptId, reason) => {
            emitAttemptDisposed(attemptId, reason);
        },
        migratePendingStreamProbeText,
        structuredLogger,
        emitWarn: (message, data) => {
            logger.warn(message, data);
        },
        lastPendingLifecycleCapacityWarnAtRef: {
            get value() {
                return lastPendingLifecycleCapacityWarnAt;
            },
            set value(next: number) {
                lastPendingLifecycleCapacityWarnAt = next;
            },
        },
    });

    // Manager initialisation

    const buttonManager = new ButtonManager(handleSaveClick, handleCalibrationClick);

    // Interception capture — delegates to interception-capture module

    const buildInterceptionCaptureDeps = (): InterceptionCaptureDeps => ({
        getStreamResolvedTitle: (cid) => streamResolvedTitles.get(cid),
        setCurrentConversation,
        setActiveAttempt,
        bindAttempt,
        peekAttemptId,
        resolveAttemptId,
        resolveAliasedAttemptId,
        evaluateReadinessForData,
        resolveReadinessDecision,
        markSnapshotCaptureMeta,
        markCanonicalCaptureMeta,
        ingestSfeCanonicalSample,
        maybeRestartCanonicalRecoveryAfterTimeout,
        scheduleCanonicalStabilizationRetry,
        refreshButtonState,
        handleResponseFinished,
        getLifecycleState: () => lifecycleState,
        structuredLogger,
    });

    const interceptionManager = new InterceptionManager((capturedId, data, meta) => {
        processInterceptionCaptureCore(capturedId, data, meta, buildInterceptionCaptureDeps());
    });

    const navigationManager = new NavigationManager(() => {
        handleNavigationChange();
    });

    // Export format

    const getExportFormat = async (): Promise<ExportFormat> => getExportFormatCore(DEFAULT_EXPORT_FORMAT);

    // Stale attempt filter — delegates to stale-attempt-filter module

    const buildStaleAttemptFilterDeps = (): StaleAttemptFilterDeps => ({
        resolveAliasedAttemptId,
        isAttemptDisposedOrSuperseded,
        attemptByConversation,
        structuredLogger,
    });

    const isStaleAttemptMessage = (
        attemptId: string,
        conversationId: string | undefined,
        signalType: 'lifecycle' | 'finished' | 'delta' | 'conversation-resolved',
    ): boolean => isStaleAttemptMessageCore(attemptId, conversationId, signalType, buildStaleAttemptFilterDeps());

    // Stream done probe

    const { cancelStreamDoneProbe, clearProbeLeaseRetry, runStreamDoneProbe } = createStreamDoneCoordinator({
        probeLease,
        probeLeaseTtlMs: PROBE_LEASE_TTL_MS,
        probeLeaseRetryGraceMs: PROBE_LEASE_RETRY_GRACE_MS,
        streamProbeControllers,
        probeLeaseRetryTimers,
        attemptByConversation,
        resolveAliasedAttemptId,
        isAttemptDisposedOrSuperseded,
        structuredLogger,
        setStreamProbePanel,
        withPreservedLiveMirrorSnapshot,
        resolveAttemptId,
        getCurrentAdapter: () => currentAdapter,
        getFetchUrlCandidates: (conversationId) =>
            currentAdapter ? getFetchUrlCandidates(currentAdapter, conversationId) : [],
        getRawSnapshotReplayUrls: (conversationId, snapshot) =>
            currentAdapter ? getRawSnapshotReplayUrls(currentAdapter, conversationId, snapshot) : [snapshot.url],
        getConversation: (conversationId) => interceptionManager.getConversation(conversationId) ?? null,
        evaluateReadiness: (data) => evaluateReadinessForData(data),
        ingestConversationData: (data, source) => interceptionManager.ingestConversationData(data, source),
        ingestInterceptedData: (args) => interceptionManager.ingestInterceptedData(args),
        requestSnapshot: requestPageSnapshot,
        buildIsolatedSnapshot: resolveIsolatedSnapshotData,
        extractResponseText: (data) => extractResponseTextFromConversation(data, currentAdapter?.name ?? 'Unknown'),
        setLastProbeKey: (key, conversationId) => {
            lastStreamProbeKey = key;
            lastStreamProbeConversationId = conversationId;
        },
        isProbeKeyActive: (key) => lastStreamProbeKey === key,
    });

    // Canonical stabilization — wrappers around the extracted tick module

    /**
     * Builds the deps object for canonical-stabilization-tick functions.
     * Cheap to call; all fields close over the runner closure by reference.
     */
    const buildCanonicalStabilizationTickDeps = (): CanonicalStabilizationTickDeps => ({
        maxRetries: CANONICAL_STABILIZATION_MAX_RETRIES,
        retryDelayMs: CANONICAL_STABILIZATION_RETRY_DELAY_MS,
        timeoutGraceMs: CANONICAL_STABILIZATION_TIMEOUT_GRACE_MS,
        retryTimers: canonicalStabilizationRetryTimers,
        retryCounts: canonicalStabilizationRetryCounts,
        startedAt: canonicalStabilizationStartedAt,
        timeoutWarnings: timeoutWarningByAttempt,
        inProgress: canonicalStabilizationInProgress,
        attemptByConversation,
        isAttemptDisposedOrSuperseded,
        resolveAliasedAttemptId,
        getSfePhase: (id) => sfe.resolve(id).phase,
        sfeRestartCanonicalRecovery: (id, now) => !!sfe.restartCanonicalRecovery(id, now),
        warmFetch: (cid) => warmFetchConversationSnapshot(cid, 'stabilization-retry'),
        requestSnapshot: requestPageSnapshot,
        buildIsolatedSnapshot: resolveIsolatedSnapshotData,
        ingestSnapshot: ingestStabilizationRetrySnapshot,
        getConversation: (cid) => interceptionManager.getConversation(cid) ?? null,
        evaluateReadiness: evaluateReadinessForData,
        getCaptureMeta,
        ingestSfeCanonicalSample,
        markCanonicalCaptureMeta,
        refreshButtonState,
        emitWarn: (attemptId, event, message, payload, key) =>
            structuredLogger.emit(attemptId, 'warn', event, message, payload, key),
        emitInfo: (attemptId, event, message, payload, key) =>
            structuredLogger.emit(attemptId, 'info', event, message, payload, key),
    });

    const clearCanonicalStabilizationRetry = (attemptId: string) =>
        clearCanonicalStabilizationRetryCore(attemptId, buildCanonicalStabilizationTickDeps());

    const hasCanonicalStabilizationTimedOut = (attemptId: string) =>
        hasCanonicalStabilizationTimedOutCore(attemptId, buildCanonicalStabilizationTickDeps());

    const scheduleCanonicalStabilizationRetry = (conversationId: string, attemptId: string) =>
        scheduleCanonicalStabilizationRetryCore(conversationId, attemptId, buildCanonicalStabilizationTickDeps());

    const maybeRestartCanonicalRecoveryAfterTimeout = (conversationId: string, attemptId: string) =>
        maybeRestartCanonicalRecoveryAfterTimeoutCore(conversationId, attemptId, buildCanonicalStabilizationTickDeps());

    /**
     * Ingests a stabilization retry snapshot (ConversationData or raw bytes)
     * into the interception cache, keyed by an internal URL for raw data.
     */
    const ingestStabilizationRetrySnapshot = (conversationId: string, data: unknown) => {
        if (isConversationDataLike(data)) {
            interceptionManager.ingestConversationData(data, 'stabilization-retry-snapshot');
            return;
        }
        interceptionManager.ingestInterceptedData({
            url: `stabilization-retry-snapshot://${currentAdapter?.name ?? 'unknown'}/${conversationId}`,
            data: JSON.stringify(data),
            platform: currentAdapter?.name ?? 'unknown',
        });
    };

    function resolveIsolatedSnapshotData(conversationId: string): ConversationData | null {
        if (!currentAdapter) {
            return null;
        }
        return buildIsolatedDomSnapshot(currentAdapter, conversationId);
    }

    const evaluateReadinessForData = (data: ConversationData): PlatformReadiness =>
        evaluateReadinessForDataPure(data, currentAdapter);

    // SFE ingestion — thin wrappers delegating to sfe-ingestion module

    const buildSfeIngestionDeps = (): SfeIngestionDeps => ({
        sfeEnabled,
        sfe,
        platformName: currentAdapter?.name ?? 'Unknown',
        resolveAttemptId,
        bindAttempt,
        evaluateReadiness: evaluateReadinessForData,
        getLifecycleState: () => lifecycleState,
        scheduleCanonicalStabilizationRetry,
        clearCanonicalStabilizationRetry,
        syncStreamProbePanelFromCanonical,
        refreshButtonState,
        structuredLogger,
    });

    const ingestSfeLifecycle = (phase: LifecyclePhase, attemptId: string, conversationId?: string | null) =>
        ingestSfeLifecycleSignalCore(phase, attemptId, conversationId, buildSfeIngestionDeps());

    const ingestSfeCanonicalSample = (
        data: ConversationData,
        attemptId?: string,
    ): ReturnType<SignalFusionEngine['applyCanonicalSample']> | null =>
        ingestSfeCanonicalSampleCore(data, attemptId, buildSfeIngestionDeps());

    const logSfeMismatchIfNeeded = (conversationId: string, legacyReady: boolean) =>
        logSfeMismatchIfNeededCore(conversationId, legacyReady, {
            sfeEnabled,
            sfe,
            structuredLogger,
            peekAttemptId: (cid) => peekAttemptId(cid),
        });

    const emitAttemptDisposed = (attemptId: string, reason: AttemptDisposedMessage['reason']) =>
        emitAttemptDisposedCore(attemptId, reason, {
            pendingLifecycleByAttempt,
            structuredLogger,
            postDisposedMessage: (aid, r) => {
                const payload: AttemptDisposedMessage = {
                    type: MESSAGE_TYPES.ATTEMPT_DISPOSED,
                    attemptId: aid,
                    reason: r as AttemptDisposedMessage['reason'],
                };
                window.postMessage(stampToken(payload), window.location.origin);
            },
        });

    const emitStreamDumpConfig = () => {
        const payload: StreamDumpConfigMessage = { type: MESSAGE_TYPES.STREAM_DUMP_CONFIG, enabled: streamDumpEnabled };
        window.postMessage(stampToken(payload), window.location.origin);
    };

    const buildStreamDumpSettingDeps = (): StreamDumpSettingDeps => ({
        setStreamDumpEnabled: (enabled) => {
            streamDumpEnabled = enabled;
        },
        emitStreamDumpConfig,
    });

    const loadStreamDumpSetting = () => loadStreamDumpSettingCore(buildStreamDumpSettingDeps());

    // Stream probe panel

    const buildStreamProbeVisibilitySettingDeps = (): StreamProbeVisibilitySettingDeps => ({
        setStreamProbeVisible: (visible) => {
            streamProbeVisible = visible;
        },
        getStreamProbeVisible: () => streamProbeVisible,
        removeStreamProbePanel,
    });

    const loadStreamProbeVisibilitySetting = () =>
        loadStreamProbeVisibilitySettingCore(buildStreamProbeVisibilitySettingDeps());
    streamProbeRuntime = createStreamProbeRuntime({
        streamPreviewState,
        isCleanedUp: () => cleanedUp,
        isStreamProbeVisible: () => streamProbeVisible,
        getAdapterName: () => currentAdapter?.name ?? '',
        getHostname: () => window.location?.hostname ?? '',
        getLastStreamProbeConversationId: () => lastStreamProbeConversationId,
    });

    // Save pipeline — thin wrappers delegating to save-pipeline module

    const buildExportPayloadForFormat = (data: ConversationData, format: ExportFormat): unknown =>
        buildExportPayloadForFormatPure(data, format, currentAdapter?.name ?? 'Unknown');

    const buildSavePipelineDeps = (): SavePipelineDeps => ({
        getAdapter: () => currentAdapter,
        resolveConversationIdForUserAction,
        getConversation: (cid) => interceptionManager.getConversation(cid),
        resolveReadinessDecision,
        shouldBlockActionsForGeneration,
        getCaptureMeta,
        getExportFormat,
        getStreamResolvedTitle: (cid) => streamResolvedTitles.get(cid) ?? null,
        evaluateReadinessForData,
        markCanonicalCaptureMeta,
        ingestSfeCanonicalSample,
        resolveAttemptId,
        peekAttemptId,
        refreshButtonState,
        requestPageSnapshot,
        warmFetchConversationSnapshot,
        ingestConversationData: (data, source) => interceptionManager.ingestConversationData(data, source),
        isConversationDataLike,
        buttonManagerExists: () => buttonManager.exists(),
        buttonManagerSetLoading: (loading, button) => buttonManager.setLoading(loading, button),
        buttonManagerSetSuccess: (button) => buttonManager.setSuccess(button),
        structuredLogger,
    });

    async function handleSaveClick() {
        await handleSaveClickCore(buildSavePipelineDeps());
    }

    async function handleCalibrationClick() {
        await handleCalibrationClickCore(buildCalibrationOrchestrationDeps());
    }

    // Warm fetch

    const buildWarmFetchDeps = (): WarmFetchDeps => ({
        platformName: currentAdapter?.name ?? 'Unknown',
        getFetchUrlCandidates: (conversationId) =>
            currentAdapter ? getFetchUrlCandidates(currentAdapter, conversationId) : [],
        ingestInterceptedData: (args) => interceptionManager.ingestInterceptedData(args),
        getConversation: (conversationId) => interceptionManager.getConversation(conversationId) ?? null,
        evaluateReadiness: (data) => evaluateReadinessForData(data),
        getCaptureMeta: (conversationId) => getCaptureMeta(conversationId),
    });

    // Calibration capture

    const buildCalibrationCaptureDeps = (_conversationId: string): CalibrationCaptureDeps => ({
        adapter: currentAdapter!,
        isCaptureSatisfied: (cid, mode) => isCalibrationCaptureSatisfied(cid, mode),
        flushQueuedMessages: () => interceptionManager.flushQueuedMessages(),
        requestSnapshot: (cid) => requestPageSnapshot(cid),
        buildIsolatedSnapshot: (cid) => (currentAdapter ? buildIsolatedDomSnapshot(currentAdapter, cid) : null),
        ingestConversationData: (data, source) => interceptionManager.ingestConversationData(data, source),
        ingestInterceptedData: (args) => interceptionManager.ingestInterceptedData(args),
        getFetchUrlCandidates: (cid) => (currentAdapter ? getFetchUrlCandidates(currentAdapter, cid) : []),
        getRawSnapshotReplayUrls: (cid, snapshot) =>
            currentAdapter ? getRawSnapshotReplayUrls(currentAdapter, cid, snapshot) : [snapshot.url],
    });

    const runCalibrationStep = (
        step: CalibrationStep,
        conversationId: string,
        mode: CalibrationMode,
    ): Promise<boolean> =>
        runCalibrationStepPure(step, conversationId, mode, buildCalibrationCaptureDeps(conversationId));

    const {
        buildCalibrationOrchestrationDeps,
        loadSfeSettings,
        ensureCalibrationPreferenceLoaded,
        syncCalibrationButtonDisplay,
        isCalibrationCaptureSatisfied,
        maybeRunAutoCapture,
        warmFetchConversationSnapshot,
        resetCalibrationPreference,
        handleCalibrationProfilesChanged,
    } = createCalibrationRuntime({
        getAdapter: () => currentAdapter,
        getCalibrationState: () => calibrationState,
        setCalibrationState: (state) => {
            calibrationState = state;
        },
        getRememberedPreferredStep: () => rememberedPreferredStep,
        setRememberedPreferredStep: (step) => {
            rememberedPreferredStep = step;
        },
        getRememberedCalibrationUpdatedAt: () => rememberedCalibrationUpdatedAt,
        setRememberedCalibrationUpdatedAt: (at) => {
            rememberedCalibrationUpdatedAt = at;
        },
        isCalibrationPreferenceLoaded: () => calibrationPreferenceLoaded,
        setCalibrationPreferenceLoaded: (loaded) => {
            calibrationPreferenceLoaded = loaded;
        },
        getCalibrationPreferenceLoading: () => calibrationPreferenceLoading,
        setCalibrationPreferenceLoading: (promise) => {
            calibrationPreferenceLoading = promise;
        },
        getSfeEnabled: () => sfeEnabled,
        setSfeEnabled: (enabled) => {
            sfeEnabled = enabled;
        },
        runCalibrationStep,
        isConversationReadyForActions,
        hasConversationData: (cid) => !!interceptionManager.getConversation(cid),
        refreshButtonState,
        buttonManagerExists: () => buttonManager.exists(),
        buttonManagerSetCalibrationState: (state, options) => buttonManager.setCalibrationState(state, options),
        syncRunnerStateCalibration: (state) => {
            runnerState.calibrationState = state;
        },
        autoCaptureAttempts,
        autoCaptureRetryTimers,
        autoCaptureDeferredLogged,
        maxAutocaptureKeys: MAX_AUTOCAPTURE_KEYS,
        peekAttemptId: (cid) => peekAttemptId(cid),
        resolveAttemptId: (cid) => resolveAttemptId(cid),
        warmFetchInFlight,
        buildWarmFetchDeps,
        buildCalibrationCaptureDeps,
    });

    // Conversation data retrieval and save — delegates to save-pipeline module

    const getConversationData = (options: { silent?: boolean; allowDegraded?: boolean } = {}) =>
        getConversationDataCore(options, buildSavePipelineDeps());

    // Lifecycle state management

    const isLifecycleActiveGeneration = (): boolean =>
        lifecycleState === 'prompt-sent' || lifecycleState === 'streaming';

    const setLifecycleState = (state: LifecycleUiState, conversationId?: string) => {
        const resolvedConversationId = conversationId ?? currentConversationId ?? null;
        if (lifecycleState !== state) {
            logger.info('Lifecycle transition', {
                from: lifecycleState,
                to: state,
                conversationId: resolvedConversationId,
            });
        }
        lifecycleState = state;
        runnerState.lifecycleState = state;
        if (state === 'idle') {
            lifecycleConversationId = null;
            lifecycleAttemptId = null;
        } else if (resolvedConversationId) {
            lifecycleConversationId = resolvedConversationId;
        }
        buttonManager.setLifecycleState(state);
        applyLifecycleButtonPresentation(state, conversationId);
        emitPublicStatusSnapshot(resolvedConversationId);
    };

    const applyLifecycleButtonPresentation = (state: LifecycleUiState, conversationId?: string) => {
        if (state === 'completed') {
            const targetId = conversationId || extractConversationIdFromLocation() || undefined;
            if (targetId) {
                refreshButtonState(targetId);
                scheduleButtonRefresh(targetId);
            }
            return;
        }
        if (state === 'prompt-sent' || state === 'streaming') {
            buttonManager.setActionButtonsEnabled(false);
            buttonManager.setOpacity('0.6');
        }
    };

    // Generation guard

    const isPlatformGenerating = (adapter: LLMPlatform | null): boolean => detectPlatformGenerating(adapter);

    const isLifecycleGenerationPhase = (conversationId: string): boolean => {
        if (lifecycleState !== 'prompt-sent' && lifecycleState !== 'streaming') {
            return false;
        }
        if (!currentConversationId) {
            return true;
        }
        return currentConversationId === conversationId;
    };

    function shouldBlockActionsForGeneration(conversationId: string): boolean {
        if (isLifecycleGenerationPhase(conversationId)) {
            return true;
        }
        if (currentAdapter?.name !== 'ChatGPT') {
            return false;
        }
        return isPlatformGenerating(currentAdapter);
    }

    // Button state — delegates to button-state-manager module

    const lastButtonStateLogRef = { value: '' };

    const buildButtonStateManagerDeps = (): ButtonStateManagerDeps => ({
        getAdapter: () => currentAdapter,
        getCurrentConversationId: () => currentConversationId,
        getLifecycleState: () => lifecycleState,
        getCalibrationState: () => calibrationState,
        setCalibrationState: (state) => {
            calibrationState = state;
        },
        getRememberedPreferredStep: () => rememberedPreferredStep,
        getRememberedCalibrationUpdatedAt: () => rememberedCalibrationUpdatedAt,
        sfeEnabled: () => sfeEnabled,
        sfe,
        attemptByConversation,
        captureMetaByConversation,
        lastCanonicalReadyLogAtByConversation,
        timeoutWarningByAttempt,
        maxConversationAttempts: MAX_CONVERSATION_ATTEMPTS,
        maxAutocaptureKeys: MAX_AUTOCAPTURE_KEYS,
        canonicalReadyLogTtlMs: CANONICAL_READY_LOG_TTL_MS,
        getConversation: (cid) => interceptionManager.getConversation(cid),
        evaluateReadinessForData,
        peekAttemptId,
        hasCanonicalStabilizationTimedOut,
        logSfeMismatchIfNeeded,
        ingestSfeCanonicalSample,
        isLifecycleActiveGeneration,
        shouldBlockActionsForGeneration,
        setCurrentConversation,
        setLifecycleState,
        syncCalibrationButtonDisplay,
        syncRunnerStateCalibration: (state) => {
            runnerState.calibrationState = state;
        },
        emitPublicStatusSnapshot,
        buttonManager: {
            exists: () => buttonManager.exists(),
            inject: (target, cid) => buttonManager.inject(target, cid),
            setLifecycleState: (state) => buttonManager.setLifecycleState(state),
            setCalibrationState: (state, options) => buttonManager.setCalibrationState(state, options),
            setSaveButtonMode: (mode) => buttonManager.setSaveButtonMode(mode),
            setActionButtonsEnabled: (enabled) => buttonManager.setActionButtonsEnabled(enabled),
            setOpacity: (opacity) => buttonManager.setOpacity(opacity),
            setButtonEnabled: (button, enabled) => buttonManager.setButtonEnabled(button, enabled),
            setReadinessSource: (source) => buttonManager.setReadinessSource(source),
        },
        structuredLogger,
    });

    const injectSaveButton = () => injectSaveButtonCore(buildButtonStateManagerDeps(), lastButtonStateLogRef);

    function resolveReadinessDecision(conversationId: string): ReadinessDecision {
        return resolveReadinessDecisionCore(conversationId, buildButtonStateManagerDeps());
    }

    function isConversationReadyForActions(
        conversationId: string,
        options: { includeDegraded?: boolean } = {},
    ): boolean {
        return isConversationReadyForActionsCore(conversationId, options, buildButtonStateManagerDeps());
    }

    function refreshButtonState(forConversationId?: string) {
        refreshButtonStateCore(forConversationId, buildButtonStateManagerDeps(), lastButtonStateLogRef);
    }

    function scheduleButtonRefresh(conversationId: string) {
        scheduleButtonRefreshCore(conversationId, buildButtonStateManagerDeps(), lastButtonStateLogRef);
    }

    // Response finished signal handling — delegates to response-finished-handler module

    const buildResponseFinishedDeps = (): ResponseFinishedDeps => ({
        extractConversationIdFromUrl: () =>
            currentAdapter ? currentAdapter.extractConversationId(window.location.href) : null,
        getCurrentConversationId: () => currentConversationId,
        peekAttemptId,
        resolveAttemptId,
        setActiveAttempt,
        setCurrentConversation,
        bindAttempt,
        ingestSfeLifecycle,
        getCalibrationState: () => calibrationState,
        shouldBlockActionsForGeneration,
        adapterName: () => currentAdapter?.name ?? null,
        getLastResponseFinished: () => ({
            at: lastResponseFinishedAt,
            conversationId: lastResponseFinishedConversationId,
            attemptId: lastResponseFinishedAttemptId,
        }),
        setLastResponseFinished: (at, cid, aid) => {
            lastResponseFinishedAt = at;
            lastResponseFinishedConversationId = cid;
            if (aid) {
                lastResponseFinishedAttemptId = aid;
            }
        },
        getConversation: (cid) => interceptionManager.getConversation(cid),
        evaluateReadiness: evaluateReadinessForData,
        getLifecycleState: () => lifecycleState,
        setCompletedLifecycleState: (cid, aid) => {
            lifecycleAttemptId = aid;
            lifecycleConversationId = cid;
            setLifecycleState('completed', cid);
        },
        runStreamDoneProbe,
        refreshButtonState,
        scheduleButtonRefresh,
        maybeRunAutoCapture,
    });

    function handleResponseFinished(source: 'network' | 'dom', hintedConversationId?: string) {
        processResponseFinishedCore(source, hintedConversationId, buildResponseFinishedDeps());
    }

    const ingestSfeLifecycleFromWirePhase = (
        phase: ResponseLifecycleMessage['phase'],
        attemptId: string,
        conversationId?: string | null,
    ) => ingestSfeLifecycleFromWirePhaseCore(phase, attemptId, conversationId, buildSfeIngestionDeps());

    const disposeInFlightAttemptsOnNavigation = (preserveConversationId?: string | null) => {
        const disposedAttemptIds = sfe
            .getAttemptTracker()
            .disposeAllForRouteChange(Date.now(), preserveConversationId ?? undefined);
        if (disposedAttemptIds.length > 0) {
            logger.info('Navigation disposing attempts', {
                count: disposedAttemptIds.length,
                attemptIds: disposedAttemptIds,
                preserveConversationId: preserveConversationId ?? null,
            });
        }
        for (const attemptId of disposedAttemptIds) {
            cancelStreamDoneProbe(attemptId, 'navigation');
            clearCanonicalStabilizationRetry(attemptId);
            clearProbeLeaseRetry(attemptId);
            emitAttemptDisposed(attemptId, 'navigation');
        }
    };

    const { registerWindowBridge, registerCompletionWatcher, registerButtonHealthCheck, handleNavigationChange } =
        createRuntimeWiring({
            getAdapter: () => currentAdapter,
            getCurrentConversationId: () => currentConversationId,
            getActiveAttemptId: () => activeAttemptId,
            resolveAliasedAttemptId,
            isStaleAttemptMessage,
            forwardAttemptAlias,
            setActiveAttempt,
            setCurrentConversation,
            bindAttempt: (conversationId, attemptId) => {
                if (!conversationId) {
                    return;
                }
                bindAttempt(conversationId, attemptId);
            },
            getLifecycleState: () => lifecycleState,
            setLifecycleState,
            getLifecycleAttemptId: () => lifecycleAttemptId,
            setLifecycleAttemptId: (attemptId) => {
                lifecycleAttemptId = attemptId;
            },
            getLifecycleConversationId: () => lifecycleConversationId,
            setLifecycleConversationId: (conversationId) => {
                lifecycleConversationId = conversationId;
            },
            isPlatformGenerating: () => !!currentAdapter && isPlatformGenerating(currentAdapter),
            streamResolvedTitles,
            maxStreamResolvedTitles: MAX_STREAM_RESOLVED_TITLES,
            getConversation: (conversationId) => interceptionManager.getConversation(conversationId) ?? undefined,
            cachePendingLifecycleSignal: (attemptId, phase, platform) =>
                cachePendingLifecycleSignal(attemptId, phase, platform),
            ingestSfeLifecycleFromWirePhase,
            handleResponseFinished,
            appendPendingStreamProbeText,
            appendLiveStreamProbeText,
            isStreamDumpEnabled: () => streamDumpEnabled,
            pendingLifecycleByAttempt,
            sfeUpdateConversationId: (attemptId, conversationId) =>
                sfe.getAttemptTracker().updateConversationId(attemptId, conversationId),
            refreshButtonState,
            cancelStreamDoneProbe,
            clearCanonicalStabilizationRetry,
            sfeDispose: (attemptId) => sfe.dispose(attemptId),
            streamPreviewState,
            attemptByConversation,
            shouldRemoveDisposedAttemptBinding: (mapped, disposed, resolve) =>
                shouldRemoveDisposedAttemptBindingFromRegistry(mapped, disposed, resolve),
            getConversationData,
            buildExportPayloadForFormat,
            stampToken,
            getCaptureMeta,
            shouldIngestAsCanonicalSample,
            scheduleCanonicalStabilizationRetry,
            runStreamDoneProbe: (conversationId, attemptId) => {
                if (!conversationId) {
                    return Promise.resolve();
                }
                return runStreamDoneProbe(conversationId, attemptId);
            },
            setStreamProbePanel,
            liveStreamPreviewByConversation,
            sfeEnabled: () => sfeEnabled,
            sfeResolve: (attemptId) => sfe.resolve(attemptId),
            getLastInvalidSessionTokenLogAt: () => lastInvalidSessionTokenLogAt,
            setLastInvalidSessionTokenLogAt: (value) => {
                lastInvalidSessionTokenLogAt = value;
            },
            extractConversationIdFromLocation,
            buttonManagerExists: () => buttonManager.exists(),
            injectSaveButton,
            isLifecycleActiveGeneration,
            updateAdapter: (adapter) => {
                currentAdapter = adapter;
                runnerState.adapter = adapter;
                if (adapter) {
                    interceptionManager.updateAdapter(adapter);
                }
            },
            buttonManagerRemove: () => buttonManager.remove(),
            resetCalibrationPreference,
            ensureCalibrationPreferenceLoaded,
            warmFetch: warmFetchConversationSnapshot,
            maybeRunAutoCapture,
            disposeInFlightAttemptsOnNavigation,
        });

    // Helpers

    function extractConversationIdFromLocation(): string | null {
        if (!currentAdapter) {
            return null;
        }
        return currentAdapter.extractConversationId(window.location.href) || null;
    }

    function resolveConversationIdForUserAction(): string | null {
        const locationId = extractConversationIdFromLocation();
        if (locationId) {
            return locationId;
        }
        if (currentConversationId && window.location.href.includes(currentConversationId)) {
            return currentConversationId;
        }
        return null;
    }

    function getCaptureMeta(conversationId: string): ExportMeta {
        return (
            captureMetaByConversation.get(conversationId) ?? {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            }
        );
    }

    // Boot sequence

    const url = window.location.href;
    currentAdapter = getPlatformAdapter(url);
    runnerState.adapter = currentAdapter;

    if (!currentAdapter) {
        logger.warn('No matching platform adapter for this URL');
        return;
    }

    logger.info(`Content script running for ${currentAdapter.name}`);
    logger.info('Runner init', { platform: currentAdapter.name, url: window.location.href });

    interceptionManager.updateAdapter(currentAdapter);
    void ensureCalibrationPreferenceLoaded(currentAdapter.name);
    void loadSfeSettings();
    void loadStreamDumpSetting();
    void loadStreamProbeVisibilitySetting();

    const buildStorageChangeListenerDeps = (): StorageChangeListenerDeps => ({
        setStreamDumpEnabled: (enabled) => {
            streamDumpEnabled = enabled;
        },
        emitStreamDumpConfig,
        setStreamProbeVisible: (visible) => {
            streamProbeVisible = visible;
        },
        removeStreamProbePanel,
        setSfeEnabled: (enabled) => {
            sfeEnabled = enabled;
        },
        refreshButtonState,
        getCurrentConversationId: () => currentConversationId,
        hasAdapter: () => !!currentAdapter,
        handleCalibrationProfilesChanged,
    });

    const storageChangeListener = createStorageChangeListenerCore(buildStorageChangeListenerDeps());
    browser.storage.onChanged.addListener(storageChangeListener);

    interceptionManager.start();
    navigationManager.start();
    cleanupWindowBridge = registerWindowBridge();
    cleanupCompletionWatcher = registerCompletionWatcher();
    cleanupButtonHealthCheck = registerButtonHealthCheck();

    const buildVisibilityRecoveryDeps = (): VisibilityRecoveryDeps => ({
        resolveConversationId: () => currentAdapter?.extractConversationId(window.location.href) ?? null,
        getCurrentConversationId: () => currentConversationId,
        resolveReadinessDecision,
        resolveAttemptId,
        maybeRestartCanonicalRecoveryAfterTimeout,
        requestPageSnapshot,
        isConversationDataLike,
        ingestConversationData: (data, source) => {
            interceptionManager.ingestConversationData(data, source);
        },
        getConversation: (conversationId) => interceptionManager.getConversation(conversationId),
        evaluateReadinessForData,
        markCanonicalCaptureMeta,
        ingestSfeCanonicalSample,
        refreshButtonState,
        warmFetchConversationSnapshot,
    });

    const handleVisibilityChange = createVisibilityChangeHandlerCore(buildVisibilityRecoveryDeps());
    document.addEventListener('visibilitychange', handleVisibilityChange);

    setCurrentConversation(currentAdapter.extractConversationId(url));
    injectSaveButton();
    if (currentConversationId) {
        void warmFetchConversationSnapshot(currentConversationId, 'initial-load');
    }

    retryTimeoutIds.push(...scheduleButtonInjectionRetriesCore(injectSaveButton, () => buttonManager.exists()));

    // Cleanup / teardown

    const buildCleanupRuntimeDeps = (): RunnerCleanupDeps => ({
        isCleanedUp: () => cleanedUp,
        markCleanedUp: () => {
            cleanedUp = true;
        },
        removeVisibilityChangeListener: () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        },
        disposeAllAttempts: () => sfe.disposeAll(),
        handleDisposedAttempt: (attemptId, reason) => {
            cancelStreamDoneProbe(attemptId, reason);
            clearCanonicalStabilizationRetry(attemptId);
            clearProbeLeaseRetry(attemptId);
            emitAttemptDisposed(attemptId, reason);
        },
        stopInterceptionManager: () => interceptionManager.stop(),
        stopNavigationManager: () => navigationManager.stop(),
        removeButtons: () => buttonManager.remove(),
        cleanupWindowBridge,
        cleanupCompletionWatcher,
        cleanupButtonHealthCheck,
        removeStorageChangeListener: () => {
            browser.storage.onChanged.removeListener(storageChangeListener);
        },
        autoCaptureRetryTimers,
        canonicalStabilizationRetryTimers,
        canonicalStabilizationRetryCounts,
        canonicalStabilizationStartedAt,
        timeoutWarningByAttempt,
        canonicalStabilizationInProgress,
        probeLeaseRetryTimers,
        streamProbeControllers,
        disposeProbeLease: () => probeLease.dispose(),
        retryTimeoutIds,
        autoCaptureDeferredLogged,
        beforeUnloadHandlerRef: {
            get value() {
                return beforeUnloadHandler;
            },
            set value(next: (() => void) | null) {
                beforeUnloadHandler = next;
            },
        },
        removeBeforeUnloadListener: (handler) => {
            window.removeEventListener('beforeunload', handler);
        },
        clearRunnerControl: () => {
            const globalControl = (window as unknown as Record<string, unknown>)[RUNNER_CONTROL_KEY] as
                | RunnerControl
                | undefined;
            if (globalControl === runnerControl) {
                delete (window as unknown as Record<string, unknown>)[RUNNER_CONTROL_KEY];
            }
        },
    });

    const cleanupRuntime = createCleanupRuntime(buildCleanupRuntimeDeps());

    beforeUnloadHandler = cleanupRuntime;
    window.addEventListener('beforeunload', cleanupRuntime);
    runnerControl.cleanup = cleanupRuntime;
};
