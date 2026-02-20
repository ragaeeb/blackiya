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
import { addBoundedSetValue, setBoundedMapValue } from '@/utils/bounded-collections';
import { streamDumpStorage } from '@/utils/diagnostics-stream-dump';
import { logger } from '@/utils/logger';
import { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import { InterceptionManager } from '@/utils/managers/interception-manager';
import { NavigationManager } from '@/utils/managers/navigation-manager';
import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import type {
    AttemptDisposedMessage,
    ConversationIdResolvedMessage,
    PublicStatusMessage,
    ResponseFinishedMessage,
    ResponseLifecycleMessage,
    StreamDeltaMessage,
    StreamDumpConfigMessage,
    StreamDumpFrameMessage,
    TitleResolvedMessage,
} from '@/utils/protocol/messages';
import {
    generateSessionToken,
    resolveTokenValidationFailureReason,
    setSessionToken,
    stampToken,
} from '@/utils/protocol/session-token';
import {
    getConversationAttemptMismatch as getConversationAttemptMismatchForRegistry,
    peekRunnerAttemptId,
    resolveRunnerAttemptId,
    shouldRemoveDisposedAttemptBinding as shouldRemoveDisposedAttemptBindingFromRegistry,
} from '@/utils/runner/attempt-registry';
import {
    type AutoCaptureDeps,
    type AutoCaptureReason,
    maybeRunAutoCapture as maybeRunAutoCaptureCore,
} from '@/utils/runner/auto-capture';
import {
    type CalibrationCaptureDeps,
    isConversationDataLike,
    runCalibrationStep as runCalibrationStepPure,
} from '@/utils/runner/calibration-capture';
import {
    buildCalibrationOrderForMode,
    type CalibrationMode,
    shouldPersistCalibrationProfile,
} from '@/utils/runner/calibration-policy';
import type { CalibrationStep } from '@/utils/runner/calibration-runner';
import { formatCalibrationTimestampLabel, resolveCalibrationDisplayState } from '@/utils/runner/calibration-ui';
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
import {
    type CalibrationOrchestrationDeps,
    ensureCalibrationPreferenceLoaded as ensureCalibrationPreferenceLoadedCore,
    handleCalibrationClick as handleCalibrationClickCore,
    isCalibrationCaptureSatisfied as isCalibrationCaptureSatisfiedCore,
    runCalibrationCapture as runCalibrationCaptureCore,
    syncCalibrationButtonDisplay as syncCalibrationButtonDisplayCore,
} from '@/utils/runner/calibration-orchestration';
import { evaluateReadinessForData as evaluateReadinessForDataPure } from '@/utils/runner/readiness-evaluation';
import {
    type InterceptionCaptureDeps,
    processInterceptionCapture as processInterceptionCaptureCore,
} from '@/utils/runner/interception-capture';
import { handleNavigationChange as handleNavigationChangeCore } from '@/utils/runner/navigation-handler';
import type { NavigationDeps } from '@/utils/runner/navigation-handler';
import { requestPageSnapshot } from '@/utils/runner/page-snapshot-bridge';
import { processResponseFinished as processResponseFinishedCore } from '@/utils/runner/response-finished-handler';
import type { ResponseFinishedDeps } from '@/utils/runner/response-finished-handler';
import {
    type SavePipelineDeps,
    getConversationData as getConversationDataCore,
    handleSaveClick as handleSaveClickCore,
} from '@/utils/runner/save-pipeline';
import { getFetchUrlCandidates, getRawSnapshotReplayUrls } from '@/utils/runner/url-candidates';
import { detectPlatformGenerating } from '@/utils/runner/generation-guard';
import { getLifecyclePhasePriority } from '@/utils/runner/lifecycle-manager';
import { dispatchRunnerMessage } from '@/utils/runner/message-bridge';
import {
    ensureStreamProbePanel,
    removeStreamProbePanel,
    resolveStreamProbeDockPosition,
    setStreamProbePanelContent,
} from '@/utils/runner/probe-panel';
import { resolveRunnerReadinessDecision } from '@/utils/runner/readiness';
import { RunnerState } from '@/utils/runner/state';
import {
    runStreamDoneProbe as runStreamDoneProbeCore,
    type StreamDoneProbeDeps,
} from '@/utils/runner/stream-done-probe';
import {
    appendLiveRunnerStreamPreview,
    appendPendingRunnerStreamPreview,
    ensureLiveRunnerStreamPreview,
    migratePendingRunnerStreamPreview,
    type RunnerStreamPreviewState,
    removePendingRunnerStreamPreview,
    withPreservedRunnerStreamMirrorSnapshot,
} from '@/utils/runner/stream-preview';
import {
    type WarmFetchDeps,
    type WarmFetchReason,
    warmFetchConversationSnapshot as warmFetchConversationSnapshotCore,
} from '@/utils/runner/warm-fetch';
import { DEFAULT_EXPORT_FORMAT, type ExportFormat, STORAGE_KEYS } from '@/utils/settings';
import {
    emitAttemptDisposed as emitAttemptDisposedCore,
    ingestSfeCanonicalSample as ingestSfeCanonicalSampleCore,
    ingestSfeLifecycleFromWirePhase as ingestSfeLifecycleFromWirePhaseCore,
    ingestSfeLifecycleSignal as ingestSfeLifecycleSignalCore,
    logSfeMismatchIfNeeded as logSfeMismatchIfNeededCore,
} from '@/utils/runner/sfe-ingestion';
import type { SfeIngestionDeps } from '@/utils/runner/sfe-ingestion';
import { shouldIngestAsCanonicalSample } from '@/utils/sfe/capture-fidelity';
import { CrossTabProbeLease } from '@/utils/sfe/cross-tab-probe-lease';
import { ReadinessGate } from '@/utils/sfe/readiness-gate';
import { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';
import type { ExportMeta, LifecyclePhase, PlatformReadiness, ReadinessDecision } from '@/utils/sfe/types';
import {
    resolveConversationTitleByPrecedence,
    resolveExportConversationTitleDecision as resolveExportTitleDecision,
} from '@/utils/title-resolver';
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
    let lastButtonStateLog = '';
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
    let publicStatusSequence = 0;
    let lastPublicStatusSignature = '';
    let cleanedUp = false;
    let beforeUnloadHandler: (() => void) | null = null;

    // Utility helpers

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

    const emitPublicStatusSnapshot = (conversationIdOverride?: string | null) => {
        const conversationId =
            conversationIdOverride === undefined
                ? (currentConversationId ?? resolveLocationConversationId())
                : conversationIdOverride;
        const attemptId = conversationId ? peekAttemptId(conversationId) : activeAttemptId;
        const platform = currentAdapter?.name ?? null;
        const lifecycle = lifecycleState;
        let readiness: PublicStatusMessage['status']['readiness'] = 'unknown';
        let readinessReason: string | null = null;
        let canGet = false;

        if (conversationId && currentAdapter) {
            const decision = resolveReadinessDecision(conversationId);
            readiness = decision.mode;
            readinessReason = decision.reason ?? null;
            canGet = decision.mode === 'canonical_ready' && !shouldBlockActionsForGeneration(conversationId);
        }

        const signature = JSON.stringify({
            platform,
            conversationId,
            attemptId,
            lifecycle,
            readiness,
            readinessReason,
            canGet,
        });
        if (signature === lastPublicStatusSignature) {
            return;
        }
        lastPublicStatusSignature = signature;
        publicStatusSequence += 1;

        const payload: PublicStatusMessage = {
            type: MESSAGE_TYPES.PUBLIC_STATUS,
            status: {
                platform,
                conversationId,
                attemptId: attemptId ?? null,
                lifecycle,
                readiness,
                readinessReason,
                canGetJSON: canGet,
                canGetCommonJSON: canGet,
                sequence: publicStatusSequence,
                timestampMs: Date.now(),
            },
        };
        window.postMessage(stampToken(payload), window.location.origin);
    };

    const setCurrentConversation = (conversationId: string | null) => {
        currentConversationId = conversationId;
        runnerState.conversationId = conversationId;
        emitPublicStatusSnapshot(conversationId);
    };

    const setActiveAttempt = (attemptId: string | null) => {
        activeAttemptId = attemptId;
        runnerState.activeAttemptId = attemptId;
        emitPublicStatusSnapshot();
    };

    const cachePendingLifecycleSignal = (
        attemptId: string,
        phase: ResponseLifecycleMessage['phase'],
        platform: string,
    ) => {
        const existing = pendingLifecycleByAttempt.get(attemptId);
        if (existing && getLifecyclePhasePriority(existing.phase) > getLifecyclePhasePriority(phase)) {
            return;
        }
        setBoundedMapValue(
            pendingLifecycleByAttempt,
            attemptId,
            { phase, platform, receivedAtMs: Date.now() },
            MAX_PENDING_LIFECYCLE_ATTEMPTS,
        );
        if (pendingLifecycleByAttempt.size >= Math.floor(MAX_PENDING_LIFECYCLE_ATTEMPTS * 0.9)) {
            const now = Date.now();
            if (now - lastPendingLifecycleCapacityWarnAt > 15_000) {
                lastPendingLifecycleCapacityWarnAt = now;
                logger.warn('Pending lifecycle cache near capacity', {
                    size: pendingLifecycleByAttempt.size,
                    maxEntries: MAX_PENDING_LIFECYCLE_ATTEMPTS,
                });
            }
        }
    };

    const setCaptureMetaForConversation = (conversationId: string, meta: ExportMeta) =>
        setBoundedMapValue(captureMetaByConversation, conversationId, meta, MAX_CONVERSATION_ATTEMPTS);

    const markSnapshotCaptureMeta = (conversationId: string) =>
        setCaptureMetaForConversation(conversationId, {
            captureSource: 'dom_snapshot_degraded',
            fidelity: 'degraded',
            completeness: 'partial',
        });

    const markCanonicalCaptureMeta = (conversationId: string) =>
        setCaptureMetaForConversation(conversationId, {
            captureSource: 'canonical_api',
            fidelity: 'high',
            completeness: 'complete',
        });

    const resolveAliasedAttemptId = (attemptId: string): string => {
        let resolved = attemptId;
        const visited = new Set<string>();
        while (attemptAliasForward.has(resolved) && !visited.has(resolved)) {
            visited.add(resolved);
            const next = attemptAliasForward.get(resolved);
            if (!next) {
                break;
            }
            resolved = next;
        }
        return resolved;
    };

    const forwardAttemptAlias = (fromAttemptId: string, toAttemptId: string, reason: 'superseded' | 'rebound') => {
        if (fromAttemptId === toAttemptId) {
            return;
        }
        setBoundedMapValue(attemptAliasForward, fromAttemptId, toAttemptId, MAX_CONVERSATION_ATTEMPTS * 2);
        structuredLogger.emit(
            toAttemptId,
            'info',
            'attempt_alias_forwarded',
            'Forwarded stale attempt alias to active attempt',
            { fromAttemptId, toAttemptId, reason },
            `attempt-alias:${fromAttemptId}:${toAttemptId}:${reason}`,
        );
    };

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

    const getExportFormat = async (): Promise<ExportFormat> => {
        try {
            const result = await browser.storage.local.get(STORAGE_KEYS.EXPORT_FORMAT);
            const value = result[STORAGE_KEYS.EXPORT_FORMAT];
            if (value === 'common' || value === 'original') {
                return value;
            }
        } catch (error) {
            logger.warn('Failed to read export format setting, using default.', error);
        }
        return DEFAULT_EXPORT_FORMAT;
    };

    // Attempt ID helpers

    function peekAttemptId(conversationId?: string): string | null {
        return peekRunnerAttemptId({
            conversationId,
            activeAttemptId,
            attemptByConversation,
            resolveAliasedAttemptId,
        });
    }

    function resolveAttemptId(conversationId?: string): string {
        const resolved = resolveRunnerAttemptId({
            conversationId,
            activeAttemptId,
            adapterName: currentAdapter?.name,
            attemptByConversation,
            resolveAliasedAttemptId,
        });
        setActiveAttempt(resolved.nextActiveAttemptId);
        return resolved.attemptId;
    }

    function bindAttempt(conversationId: string | undefined, attemptId: string) {
        if (!conversationId) {
            return;
        }
        const canonicalAttemptId = resolveAliasedAttemptId(attemptId);
        const isNewBinding = !attemptByConversation.has(conversationId);
        const previous = attemptByConversation.get(conversationId);
        if (previous && previous !== canonicalAttemptId) {
            const canonicalPrevious = resolveAliasedAttemptId(previous);
            sfe.getAttemptTracker().markSuperseded(canonicalPrevious, attemptId);
            cancelStreamDoneProbe(canonicalPrevious, 'superseded');
            clearCanonicalStabilizationRetry(canonicalPrevious);
            clearProbeLeaseRetry(canonicalPrevious);
            emitAttemptDisposed(canonicalPrevious, 'superseded');
            forwardAttemptAlias(previous, attemptId, 'superseded');
            structuredLogger.emit(
                canonicalPrevious,
                'info',
                'attempt_superseded',
                'Attempt superseded by newer prompt',
                { conversationId, supersededBy: attemptId },
                `supersede:${conversationId}:${attemptId}`,
            );
        }
        setBoundedMapValue(attemptByConversation, conversationId, canonicalAttemptId, MAX_CONVERSATION_ATTEMPTS);
        migratePendingStreamProbeText(conversationId, canonicalAttemptId);
        if (isNewBinding || previous !== canonicalAttemptId) {
            structuredLogger.emit(
                attemptId,
                'debug',
                'attempt_created',
                'Attempt binding created',
                { conversationId },
                `attempt-created:${conversationId}:${attemptId}`,
            );
        }
    }

    const isAttemptDisposedOrSuperseded = (attemptId: string): boolean => {
        const phase = sfe.resolve(attemptId).phase;
        return phase === 'disposed' || phase === 'superseded';
    };

    const emitAliasResolutionLog = (
        canonicalAttemptId: string,
        signalType: 'lifecycle' | 'finished' | 'delta' | 'conversation-resolved',
        originalAttemptId: string,
        conversationId?: string,
    ) => {
        structuredLogger.emit(
            canonicalAttemptId,
            'debug',
            'attempt_alias_forwarded',
            'Resolved stale attempt alias before processing signal',
            { signalType, originalAttemptId, canonicalAttemptId, conversationId: conversationId ?? null },
            `attempt-alias-resolve:${signalType}:${originalAttemptId}:${canonicalAttemptId}`,
        );
    };

    const emitLateSignalDrop = (
        canonicalAttemptId: string,
        signalType: 'lifecycle' | 'finished' | 'delta' | 'conversation-resolved',
        conversationId?: string,
    ) => {
        structuredLogger.emit(
            canonicalAttemptId,
            'debug',
            'late_signal_dropped_after_dispose',
            'Dropped late signal for disposed or superseded attempt',
            { signalType, reason: 'disposed_or_superseded', conversationId: conversationId ?? null },
            `stale:${signalType}:${conversationId ?? 'unknown'}:disposed`,
        );
    };

    const getConversationAttemptMismatch = (canonicalAttemptId: string, conversationId?: string): string | null =>
        getConversationAttemptMismatchForRegistry(
            canonicalAttemptId,
            conversationId,
            attemptByConversation,
            resolveAliasedAttemptId,
        );

    const emitConversationMismatchDrop = (
        canonicalAttemptId: string,
        signalType: 'lifecycle' | 'finished' | 'delta' | 'conversation-resolved',
        conversationId: string,
        activeAttemptIdParam: string,
    ) => {
        structuredLogger.emit(
            canonicalAttemptId,
            'debug',
            'stale_signal_ignored',
            'Ignored stale attempt signal',
            { signalType, reason: 'conversation_mismatch', conversationId, activeAttemptId: activeAttemptIdParam },
            `stale:${signalType}:${conversationId}:${activeAttemptIdParam}`,
        );
    };

    const isStaleAttemptMessage = (
        attemptId: string,
        conversationId: string | undefined,
        signalType: 'lifecycle' | 'finished' | 'delta' | 'conversation-resolved',
    ): boolean => {
        const canonicalAttemptId = resolveAliasedAttemptId(attemptId);
        if (canonicalAttemptId !== attemptId) {
            emitAliasResolutionLog(canonicalAttemptId, signalType, attemptId, conversationId);
        }
        if (isAttemptDisposedOrSuperseded(canonicalAttemptId)) {
            emitLateSignalDrop(canonicalAttemptId, signalType, conversationId);
            return true;
        }
        const mismatchedAttemptId = getConversationAttemptMismatch(canonicalAttemptId, conversationId);
        if (conversationId && mismatchedAttemptId) {
            emitConversationMismatchDrop(canonicalAttemptId, signalType, conversationId, mismatchedAttemptId);
            return true;
        }
        return false;
    };

    // Stream done probe (delegates to stream-done-probe module)

    function cancelStreamDoneProbe(attemptId: string, reason: 'superseded' | 'disposed' | 'navigation' | 'teardown') {
        const controller = streamProbeControllers.get(attemptId);
        if (!controller) {
            return;
        }
        streamProbeControllers.delete(attemptId);
        controller.abort();
        structuredLogger.emit(
            attemptId,
            'debug',
            'probe_cancelled',
            'Stream done probe canceled',
            { reason },
            `probe-cancel:${reason}`,
        );
    }

    function clearProbeLeaseRetry(attemptId: string) {
        const timerId = probeLeaseRetryTimers.get(attemptId);
        if (timerId !== undefined) {
            clearTimeout(timerId);
            probeLeaseRetryTimers.delete(attemptId);
        }
    }

    const tryAcquireProbeLease = async (conversationId: string, attemptId: string): Promise<boolean> => {
        const claim = await probeLease.claim(conversationId, attemptId, PROBE_LEASE_TTL_MS);
        if (claim.acquired) {
            clearProbeLeaseRetry(attemptId);
            return true;
        }
        structuredLogger.emit(
            attemptId,
            'debug',
            'probe_lease_blocked',
            'Probe lease held by another tab',
            { conversationId, ownerAttemptId: claim.ownerAttemptId, expiresAtMs: claim.expiresAtMs },
            `probe-lease-blocked:${conversationId}:${claim.ownerAttemptId ?? 'unknown'}`,
        );
        if (!probeLeaseRetryTimers.has(attemptId) && !isAttemptDisposedOrSuperseded(attemptId)) {
            const now = Date.now();
            const expiresAtMs = claim.expiresAtMs ?? now + PROBE_LEASE_RETRY_GRACE_MS;
            const delayMs = Math.max(expiresAtMs - now + PROBE_LEASE_RETRY_GRACE_MS, PROBE_LEASE_RETRY_GRACE_MS);
            const timerId = window.setTimeout(() => {
                probeLeaseRetryTimers.delete(attemptId);
                if (isAttemptDisposedOrSuperseded(attemptId)) {
                    return;
                }
                const mappedAttempt = attemptByConversation.get(conversationId);
                if (mappedAttempt && resolveAliasedAttemptId(mappedAttempt) !== attemptId) {
                    return;
                }
                void runStreamDoneProbe(conversationId, attemptId);
            }, delayMs);
            probeLeaseRetryTimers.set(attemptId, timerId);
        }
        setStreamProbePanel(
            'stream-done: lease held by another tab',
            withPreservedLiveMirrorSnapshot(
                conversationId,
                'stream-done: lease held by another tab',
                `Another tab is probing canonical capture for ${conversationId}. Retrying shortly.`,
            ),
        );
        return false;
    };

    const buildStreamDoneProbeDeps = (): StreamDoneProbeDeps => ({
        platformName: currentAdapter?.name ?? 'Unknown',
        parseInterceptedData: (text, url) => currentAdapter?.parseInterceptedData(text, url) ?? null,
        isAttemptDisposedOrSuperseded,
        acquireProbeLease: tryAcquireProbeLease,
        releaseProbeLease: (cid, aid) => probeLease.release(cid, aid),
        cancelExistingProbe: (aid) => cancelStreamDoneProbe(aid, 'superseded'),
        registerProbeController: (aid, ctrl) => streamProbeControllers.set(aid, ctrl),
        unregisterProbeController: (aid) => streamProbeControllers.delete(aid),
        resolveAttemptId,
        getFetchUrlCandidates: (cid) => (currentAdapter ? getFetchUrlCandidates(currentAdapter, cid) : []),
        getRawSnapshotReplayUrls: (cid, snap) =>
            currentAdapter ? getRawSnapshotReplayUrls(currentAdapter, cid, snap) : [snap.url],
        getConversation: (cid) => interceptionManager.getConversation(cid) ?? null,
        evaluateReadiness: evaluateReadinessForData,
        ingestConversationData: (data, source) => interceptionManager.ingestConversationData(data, source),
        ingestInterceptedData: (args) => interceptionManager.ingestInterceptedData(args),
        requestSnapshot: requestPageSnapshot,
        buildIsolatedSnapshot: resolveIsolatedSnapshotData,
        extractResponseText: (data) => extractResponseTextFromConversation(data, currentAdapter?.name ?? 'Unknown'),
        setStreamDonePanel: (cid, status, body) =>
            setStreamProbePanel(status, withPreservedLiveMirrorSnapshot(cid, status, body)),
        onProbeActive: (key, cid) => {
            lastStreamProbeKey = key;
            lastStreamProbeConversationId = cid;
        },
        isProbeKeyActive: (key) => lastStreamProbeKey === key,
        emitLog: (level, message, payload) =>
            level === 'info' ? logger.info(message, payload) : logger.warn(message, payload),
    });

    const runStreamDoneProbe = (conversationId: string, hintedAttemptId?: string): Promise<void> => {
        if (!currentAdapter) {
            return Promise.resolve();
        }
        return runStreamDoneProbeCore(conversationId, hintedAttemptId, buildStreamDoneProbeDeps());
    };

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
                const payload: AttemptDisposedMessage = { type: MESSAGE_TYPES.ATTEMPT_DISPOSED, attemptId: aid, reason: r as AttemptDisposedMessage['reason'] };
                window.postMessage(stampToken(payload), window.location.origin);
            },
        });

    const emitStreamDumpConfig = () => {
        const payload: StreamDumpConfigMessage = { type: MESSAGE_TYPES.STREAM_DUMP_CONFIG, enabled: streamDumpEnabled };
        window.postMessage(stampToken(payload), window.location.origin);
    };

    const loadStreamDumpSetting = async () => {
        try {
            const result = await browser.storage.local.get(STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_ENABLED);
            streamDumpEnabled = result[STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_ENABLED] === true;
        } catch (error) {
            logger.warn('Failed to load stream dump diagnostics setting', error);
            streamDumpEnabled = false;
        }
        emitStreamDumpConfig();
    };

    // Stream probe panel

    const loadStreamProbeVisibilitySetting = async () => {
        try {
            const result = await browser.storage.local.get(STORAGE_KEYS.STREAM_PROBE_VISIBLE);
            streamProbeVisible = result[STORAGE_KEYS.STREAM_PROBE_VISIBLE] === true;
        } catch (error) {
            logger.warn('Failed to load stream probe visibility setting', error);
            streamProbeVisible = false;
        }
        if (!streamProbeVisible) {
            removeStreamProbePanel();
        }
    };

    function setStreamProbePanel(status: string, body: string) {
        if (cleanedUp || !streamProbeVisible) {
            return;
        }
        const dockPosition = resolveStreamProbeDockPosition(
            currentAdapter?.name ?? '',
            window.location?.hostname ?? '',
        );
        const panel = ensureStreamProbePanel(streamProbeVisible, dockPosition);
        if (!panel) {
            return;
        }
        setStreamProbePanelContent(panel, status, body);
    }

    function withPreservedLiveMirrorSnapshot(conversationId: string, status: string, primaryBody: string): string {
        return withPreservedRunnerStreamMirrorSnapshot(streamPreviewState, conversationId, status, primaryBody);
    }

    function syncStreamProbePanelFromCanonical(conversationId: string, data: ConversationData) {
        const panel = document.getElementById('blackiya-stream-probe');
        if (!panel || lastStreamProbeConversationId !== conversationId) {
            return;
        }
        const panelText = panel.textContent ?? '';
        if (!panelText.includes('stream-done: awaiting canonical capture')) {
            return;
        }
        const cachedText = extractResponseTextFromConversation(data, currentAdapter?.name ?? 'Unknown');
        const body = cachedText.length > 0 ? cachedText : '(captured cache ready; no assistant text extracted)';
        setStreamProbePanel(
            'stream-done: canonical capture ready',
            withPreservedLiveMirrorSnapshot(conversationId, 'stream-done: canonical capture ready', body),
        );
    }

    const appendPendingStreamProbeText = (canonicalAttemptId: string, text: string) => {
        const capped = appendPendingRunnerStreamPreview(streamPreviewState, canonicalAttemptId, text);
        setStreamProbePanel('stream: awaiting conversation id', capped);
    };

    function migratePendingStreamProbeText(conversationId: string, canonicalAttemptId: string) {
        const capped = migratePendingRunnerStreamPreview(streamPreviewState, conversationId, canonicalAttemptId);
        if (!capped) {
            return;
        }
        setStreamProbePanel('stream: live mirror', capped);
    }

    const appendLiveStreamProbeText = (conversationId: string, text: string) => {
        const capped = appendLiveRunnerStreamPreview(streamPreviewState, conversationId, text);
        setStreamProbePanel('stream: live mirror', capped);
    };

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

    const warmFetchConversationSnapshot = (conversationId: string, reason: WarmFetchReason): Promise<boolean> =>
        warmFetchConversationSnapshotCore(conversationId, reason, buildWarmFetchDeps(), warmFetchInFlight);

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

    // Calibration orchestration — thin wrappers delegating to calibration-orchestration module

    const loadSfeSettings = async () => {
        try {
            const result = await browser.storage.local.get([STORAGE_KEYS.SFE_ENABLED]);
            sfeEnabled = result[STORAGE_KEYS.SFE_ENABLED] !== false;
            logger.info('SFE settings loaded', { sfeEnabled, probeLeaseArbitration: 'always_on' });
        } catch (error) {
            logger.warn('Failed to load SFE settings. Falling back to defaults.', error);
            sfeEnabled = true;
        }
    };

    const buildCalibrationOrchestrationDeps = (): CalibrationOrchestrationDeps => ({
        getAdapter: () => currentAdapter,
        getCalibrationState: () => calibrationState,
        setCalibrationState: (state) => { calibrationState = state; },
        getRememberedPreferredStep: () => rememberedPreferredStep,
        setRememberedPreferredStep: (step) => { rememberedPreferredStep = step; },
        getRememberedCalibrationUpdatedAt: () => rememberedCalibrationUpdatedAt,
        setRememberedCalibrationUpdatedAt: (at) => { rememberedCalibrationUpdatedAt = at; },
        isCalibrationPreferenceLoaded: () => calibrationPreferenceLoaded,
        setCalibrationPreferenceLoaded: (loaded) => { calibrationPreferenceLoaded = loaded; },
        getCalibrationPreferenceLoading: () => calibrationPreferenceLoading,
        setCalibrationPreferenceLoading: (promise) => { calibrationPreferenceLoading = promise; },
        runCalibrationStep,
        isConversationReadyForActions,
        hasConversationData: (cid) => !!interceptionManager.getConversation(cid),
        refreshButtonState,
        buttonManagerExists: () => buttonManager.exists(),
        buttonManagerSetCalibrationState: (state, options) => buttonManager.setCalibrationState(state, options),
        syncRunnerStateCalibration: (state) => { runnerState.calibrationState = state; },
    });

    const ensureCalibrationPreferenceLoaded = (platformName: string): Promise<void> =>
        ensureCalibrationPreferenceLoadedCore(platformName, buildCalibrationOrchestrationDeps());

    const syncCalibrationButtonDisplay = () =>
        syncCalibrationButtonDisplayCore(buildCalibrationOrchestrationDeps());

    const isCalibrationCaptureSatisfied = (conversationId: string, mode: CalibrationMode): boolean =>
        isCalibrationCaptureSatisfiedCore(conversationId, mode, buildCalibrationOrchestrationDeps());

    const runCalibrationCapture = (mode?: CalibrationMode, hintedConversationId?: string) =>
        runCalibrationCaptureCore(mode, hintedConversationId, buildCalibrationOrchestrationDeps());

    // Auto-capture — wrappers around the extracted auto-capture module

    /**
     * Builds the deps object for auto-capture functions.
     * Cheap to call; all fields close over the runner closure by reference.
     */
    const buildAutoCaptureDeps = (): AutoCaptureDeps => ({
        getAdapter: () => currentAdapter,
        getCalibrationState: () => calibrationState,
        isConversationReadyForActions,
        isPlatformGenerating: (adapter) => detectPlatformGenerating(adapter),
        peekAttemptId: (cid) => peekAttemptId(cid),
        resolveAttemptId: (cid) => resolveAttemptId(cid),
        getRememberedPreferredStep: () => rememberedPreferredStep,
        isCalibrationPreferenceLoaded: () => calibrationPreferenceLoaded,
        ensureCalibrationPreferenceLoaded,
        runCalibrationCapture,
        autoCaptureAttempts,
        autoCaptureRetryTimers,
        autoCaptureDeferredLogged,
        maxKeys: MAX_AUTOCAPTURE_KEYS,
    });

    const maybeRunAutoCapture = (conversationId: string, reason: AutoCaptureReason) =>
        maybeRunAutoCaptureCore(conversationId, reason, buildAutoCaptureDeps());

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
        if (state === 'completed') {
            const targetId = conversationId || extractConversationIdFromLocation() || undefined;
            if (targetId) {
                refreshButtonState(targetId);
                scheduleButtonRefresh(targetId);
            }
        } else if (state === 'prompt-sent' || state === 'streaming') {
            buttonManager.setActionButtonsEnabled(false);
            buttonManager.setOpacity('0.6');
        }
        emitPublicStatusSnapshot(resolvedConversationId);
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

    // Button state

    const injectSaveButton = () => {
        const conversationId = extractConversationIdFromLocation();
        const target = currentAdapter?.getButtonInjectionTarget();
        if (!target) {
            logger.info('Button target missing; retry pending', {
                platform: currentAdapter?.name ?? 'unknown',
                conversationId,
            });
            return;
        }
        buttonManager.inject(target, conversationId);
        buttonManager.setLifecycleState(lifecycleState);
        const displayState = resolveCalibrationDisplayState(calibrationState, !!rememberedPreferredStep);
        buttonManager.setCalibrationState(displayState, {
            timestampLabel:
                displayState === 'success' ? formatCalibrationTimestampLabel(rememberedCalibrationUpdatedAt) : null,
        });

        if (!conversationId) {
            logger.info('No conversation ID yet; showing calibration only');
            setCurrentConversation(null);
            if (!isLifecycleActiveGeneration() && lifecycleState !== 'idle') {
                setLifecycleState('idle');
            }
            buttonManager.setSaveButtonMode('default');
            buttonManager.setActionButtonsEnabled(false);
            buttonManager.setOpacity('0.6');
            return;
        }
        buttonManager.setActionButtonsEnabled(true);
        setCurrentConversation(conversationId);
        refreshButtonState(conversationId);
        scheduleButtonRefresh(conversationId);
    };

    const resetButtonStateForNoConversation = () => {
        setCurrentConversation(null);
        if (!isLifecycleActiveGeneration() && lifecycleState !== 'idle') {
            setLifecycleState('idle');
        }
        buttonManager.setSaveButtonMode('default');
        buttonManager.setActionButtonsEnabled(false);
        buttonManager.setOpacity('0.6');
    };

    const shouldLogCanonicalReadyDecision = (conversationId: string): boolean => {
        const now = Date.now();
        const lastLoggedAt = lastCanonicalReadyLogAtByConversation.get(conversationId);
        if (lastLoggedAt !== undefined && now - lastLoggedAt < CANONICAL_READY_LOG_TTL_MS) {
            return false;
        }
        setBoundedMapValue(lastCanonicalReadyLogAtByConversation, conversationId, now, MAX_CONVERSATION_ATTEMPTS);
        return true;
    };

    const emitTimeoutWarningOnce = (attemptId: string, conversationId: string) => {
        if (timeoutWarningByAttempt.has(attemptId)) {
            return;
        }
        addBoundedSetValue(timeoutWarningByAttempt, attemptId, MAX_AUTOCAPTURE_KEYS);
        structuredLogger.emit(
            attemptId,
            'warn',
            'readiness_timeout_manual_only',
            'Stabilization timed out; manual force save required',
            { conversationId },
            `readiness-timeout:${conversationId}`,
        );
    };

    function resolveReadinessDecision(conversationId: string): ReadinessDecision {
        const captureMeta = getCaptureMeta(conversationId);
        const sfeResolution = sfe.resolveByConversation(conversationId);
        return resolveRunnerReadinessDecision({
            conversationId,
            data: interceptionManager.getConversation(conversationId) ?? null,
            sfeEnabled,
            captureMeta,
            sfeResolution: sfeResolution
                ? {
                      ready: sfeResolution.ready,
                      reason: sfeResolution.reason,
                      blockingConditions: [...sfeResolution.blockingConditions],
                  }
                : null,
            evaluateReadinessForData,
            resolveAttemptId: (cid) => peekAttemptId(cid),
            hasCanonicalStabilizationTimedOut,
            emitTimeoutWarningOnce,
            clearTimeoutWarningByAttempt: (attemptId) => {
                timeoutWarningByAttempt.delete(attemptId);
            },
            logSfeMismatchIfNeeded,
            shouldLogCanonicalReadyDecision,
            clearCanonicalReadyLogStamp: (id) => {
                lastCanonicalReadyLogAtByConversation.delete(id);
            },
            loggerDebug: (message, payload) => {
                logger.debug(message, payload);
            },
        });
    }

    function isConversationReadyForActions(
        conversationId: string,
        options: { includeDegraded?: boolean } = {},
    ): boolean {
        const decision = resolveReadinessDecision(conversationId);
        if (decision.mode === 'canonical_ready') {
            return true;
        }
        return options.includeDegraded === true && decision.mode === 'degraded_manual_only';
    }

    function refreshButtonState(forConversationId?: string) {
        if (!currentAdapter) {
            emitPublicStatusSnapshot(null);
            return;
        }
        const conversationId = forConversationId || currentAdapter.extractConversationId(window.location.href);
        if (!buttonManager.exists()) {
            emitPublicStatusSnapshot(conversationId);
            return;
        }
        if (!conversationId) {
            resetButtonStateForNoConversation();
            emitPublicStatusSnapshot(null);
            return;
        }
        const shouldDisable =
            (lifecycleState === 'prompt-sent' || lifecycleState === 'streaming') &&
            (!currentConversationId || conversationId === currentConversationId);
        if (shouldDisable || (lifecycleState !== 'completed' && shouldBlockActionsForGeneration(conversationId))) {
            buttonManager.setSaveButtonMode('default');
            buttonManager.setActionButtonsEnabled(false);
            buttonManager.setOpacity('0.6');
            logButtonStateIfChanged(conversationId, false, '0.6');
            emitPublicStatusSnapshot(conversationId);
            return;
        }

        const cached = interceptionManager.getConversation(conversationId);
        const captureMeta = getCaptureMeta(conversationId);
        if (cached && shouldIngestAsCanonicalSample(captureMeta)) {
            ingestSfeCanonicalSample(cached, attemptByConversation.get(conversationId));
        }

        const decision = resolveReadinessDecision(conversationId);
        const isCanonicalReady = decision.mode === 'canonical_ready';
        const isDegraded = decision.mode === 'degraded_manual_only';
        const hasData = isCanonicalReady || isDegraded;

        buttonManager.setReadinessSource(sfeEnabled ? 'sfe' : 'legacy');
        buttonManager.setSaveButtonMode(isDegraded ? 'force-degraded' : 'default');
        if (isDegraded) {
            buttonManager.setButtonEnabled('save', true);
        } else {
            buttonManager.setActionButtonsEnabled(isCanonicalReady);
        }

        const opacity = hasData ? '1' : '0.6';
        buttonManager.setOpacity(opacity);
        logButtonStateIfChanged(conversationId, hasData, opacity);

        if (isCanonicalReady && calibrationState !== 'capturing') {
            calibrationState = 'success';
            runnerState.calibrationState = 'success';
            syncCalibrationButtonDisplay();
        } else if (!isCanonicalReady && calibrationState === 'success') {
            calibrationState = 'idle';
            runnerState.calibrationState = 'idle';
            syncCalibrationButtonDisplay();
        }

        emitPublicStatusSnapshot(conversationId);
    }

    function scheduleButtonRefresh(conversationId: string) {
        let attempts = 0;
        const maxAttempts = 6;
        const tick = () => {
            attempts += 1;
            if (!buttonManager.exists()) {
                return;
            }
            const decision = resolveReadinessDecision(conversationId);
            if (decision.mode === 'canonical_ready' || decision.mode === 'degraded_manual_only') {
                refreshButtonState(conversationId);
                return;
            }
            buttonManager.setSaveButtonMode('default');
            buttonManager.setActionButtonsEnabled(false);
            if (attempts < maxAttempts) {
                setTimeout(tick, 500);
            } else {
                logButtonStateIfChanged(conversationId, false, '0.6');
            }
        };
        setTimeout(tick, 500);
    }

    function logButtonStateIfChanged(conversationId: string, hasData: boolean, opacity: string) {
        const key = `${conversationId}:${hasData ? 'ready' : 'waiting'}:${opacity}`;
        if (lastButtonStateLog === key) {
            return;
        }
        lastButtonStateLog = key;
        logger.info('Button state', {
            conversationId,
            hasData,
            opacity,
            lifecycleState,
            hasCachedData: !!interceptionManager.getConversation(conversationId),
        });
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

    // Wire message handlers

    const handleTitleResolvedMessage = (message: unknown): boolean => {
        const typed = message as TitleResolvedMessage | undefined;
        if (
            typed?.type !== MESSAGE_TYPES.TITLE_RESOLVED ||
            typeof typed.conversationId !== 'string' ||
            typeof typed.title !== 'string'
        ) {
            return false;
        }
        const title = typed.title.trim();
        if (title.length === 0) {
            return true;
        }
        const platformDefaultTitles = currentAdapter?.defaultTitles;
        const streamDecision = resolveConversationTitleByPrecedence({
            streamTitle: title,
            cachedTitle: streamResolvedTitles.get(typed.conversationId) ?? null,
            fallbackTitle: title,
            platformDefaultTitles,
        });
        setBoundedMapValue(
            streamResolvedTitles,
            typed.conversationId,
            streamDecision.title,
            MAX_STREAM_RESOLVED_TITLES,
        );
        const cached = interceptionManager.getConversation(typed.conversationId);
        if (cached) {
            const cacheDecision = resolveConversationTitleByPrecedence({
                streamTitle: title,
                cachedTitle: cached.title ?? null,
                fallbackTitle: cached.title ?? 'Conversation',
                platformDefaultTitles,
            });
            cached.title = cacheDecision.title;
        }
        logger.info('Title resolved from stream', {
            conversationId: typed.conversationId,
            title,
            resolvedTitle: streamDecision.title,
            source: streamDecision.source,
        });
        return true;
    };

    const handleResponseFinishedMessage = (message: unknown): boolean => {
        const typed = message as ResponseFinishedMessage | undefined;
        if (typed?.type !== MESSAGE_TYPES.RESPONSE_FINISHED || typeof typed.attemptId !== 'string') {
            return false;
        }
        const hintedConversationId = typeof typed.conversationId === 'string' ? typed.conversationId : undefined;
        const resolvedConversationId =
            hintedConversationId ??
            (currentAdapter ? currentAdapter.extractConversationId(window.location.href) : null) ??
            currentConversationId;
        if (!resolvedConversationId) {
            logger.info('RESPONSE_FINISHED ignored: missing conversation context', {
                attemptId: typed.attemptId,
                platform: typed.platform,
            });
            return true;
        }
        const attemptId = resolveAliasedAttemptId(typed.attemptId);
        if (isStaleAttemptMessage(attemptId, resolvedConversationId, 'finished')) {
            return true;
        }
        setActiveAttempt(attemptId);
        bindAttempt(resolvedConversationId, attemptId);
        if (lifecycleState === 'prompt-sent' || lifecycleState === 'streaming') {
            const shouldReject =
                currentAdapter?.name === 'ChatGPT' && currentAdapter && isPlatformGenerating(currentAdapter);
            if (shouldReject) {
                logger.info('RESPONSE_FINISHED rejected: platform still generating', {
                    conversationId: resolvedConversationId,
                    attemptId,
                    lifecycleState,
                });
                return true;
            }
            logger.info('RESPONSE_FINISHED promoted lifecycle to completed', {
                conversationId: resolvedConversationId,
                attemptId,
                previousLifecycle: lifecycleState,
            });
            lifecycleAttemptId = attemptId;
            lifecycleConversationId = resolvedConversationId;
            setLifecycleState('completed', resolvedConversationId);
        }
        handleResponseFinished('network', resolvedConversationId);
        return true;
    };

    const ingestSfeLifecycleFromWirePhase = (
        phase: ResponseLifecycleMessage['phase'],
        attemptId: string,
        conversationId?: string | null,
    ) => ingestSfeLifecycleFromWirePhaseCore(phase, attemptId, conversationId, buildSfeIngestionDeps());

    const applyActiveLifecyclePhase = (
        phase: 'prompt-sent' | 'streaming',
        attemptId: string,
        conversationId: string,
        source: 'direct' | 'replayed',
    ) => {
        if (
            lifecycleState === 'completed' &&
            lifecycleConversationId === conversationId &&
            lifecycleAttemptId === attemptId
        ) {
            logger.info('Lifecycle regression blocked', {
                from: lifecycleState,
                to: phase,
                attemptId,
                conversationId,
                source,
            });
            return;
        }
        if (!liveStreamPreviewByConversation.has(conversationId)) {
            ensureLiveRunnerStreamPreview(streamPreviewState, conversationId);
            setStreamProbePanel('stream: awaiting delta', `conversationId=${conversationId}`);
        }
        lifecycleAttemptId = attemptId;
        lifecycleConversationId = conversationId;
        setLifecycleState(phase, conversationId);
    };

    const applyLifecyclePhaseForConversation = (
        phase: ResponseLifecycleMessage['phase'],
        platform: string,
        attemptId: string,
        conversationId: string,
        source: 'direct' | 'replayed',
    ) => {
        logger.info('Lifecycle phase', { platform, phase, attemptId, conversationId, source });
        ingestSfeLifecycleFromWirePhase(phase, attemptId, conversationId);
        if (phase === 'prompt-sent' || phase === 'streaming') {
            applyActiveLifecyclePhase(phase, attemptId, conversationId, source);
            return;
        }
        if (phase === 'completed') {
            lifecycleAttemptId = attemptId;
            lifecycleConversationId = conversationId;
            setLifecycleState('completed', conversationId);
            if (!sfeEnabled) {
                void runStreamDoneProbe(conversationId, attemptId);
                return;
            }
            const resolution = sfe.resolve(attemptId);
            const captureMeta = getCaptureMeta(conversationId);
            const shouldRetry =
                !resolution.blockingConditions.includes('stabilization_timeout') &&
                !resolution.ready &&
                (resolution.phase === 'canonical_probing' || !shouldIngestAsCanonicalSample(captureMeta));
            if (shouldRetry) {
                scheduleCanonicalStabilizationRetry(conversationId, attemptId);
            }
            void runStreamDoneProbe(conversationId, attemptId);
        }
    };

    const handleLifecycleMessage = (message: unknown): boolean => {
        const typed = message as ResponseLifecycleMessage | undefined;
        if (typed?.type !== MESSAGE_TYPES.RESPONSE_LIFECYCLE || typeof typed.attemptId !== 'string') {
            return false;
        }
        const phase = typed.phase;
        if (phase !== 'prompt-sent' && phase !== 'streaming' && phase !== 'completed' && phase !== 'terminated') {
            return false;
        }
        const attemptId = resolveAliasedAttemptId(typed.attemptId);
        const conversationId = typeof typed.conversationId === 'string' ? typed.conversationId : undefined;

        if (!conversationId) {
            cachePendingLifecycleSignal(attemptId, phase, typed.platform);
            ingestSfeLifecycleFromWirePhase(phase, attemptId, null);
            logger.info('Lifecycle pending conversation resolution', {
                phase,
                platform: typed.platform,
                attemptId: typed.attemptId,
            });
            if (phase === 'prompt-sent' || phase === 'streaming') {
                lifecycleAttemptId = attemptId;
                setLifecycleState(phase);
            }
            return true;
        }

        if (phase === 'prompt-sent') {
            bindAttempt(conversationId, attemptId);
        }
        if (isStaleAttemptMessage(attemptId, conversationId, 'lifecycle')) {
            return true;
        }
        setCurrentConversation(conversationId);
        bindAttempt(conversationId, attemptId);
        setActiveAttempt(attemptId);
        applyLifecyclePhaseForConversation(phase, typed.platform, attemptId, conversationId, 'direct');
        return true;
    };

    const handleStreamDeltaMessage = (message: unknown): boolean => {
        const typed = message as StreamDeltaMessage | undefined;
        if (typed?.type !== MESSAGE_TYPES.STREAM_DELTA || typeof typed.attemptId !== 'string') {
            return false;
        }
        if (typeof typed.text !== 'string' || typed.text.length === 0) {
            return false;
        }
        const conversationId =
            typeof typed.conversationId === 'string' && typed.conversationId.length > 0
                ? typed.conversationId
                : currentConversationId;
        const attemptId = resolveAliasedAttemptId(typed.attemptId);
        if (isStaleAttemptMessage(attemptId, conversationId ?? undefined, 'delta')) {
            return true;
        }
        setActiveAttempt(attemptId);
        if (!conversationId) {
            if (lifecycleState !== 'completed' && lifecycleState !== 'streaming') {
                lifecycleAttemptId = attemptId;
                setLifecycleState('streaming');
            }
            appendPendingStreamProbeText(attemptId, typed.text);
            return true;
        }
        bindAttempt(conversationId, attemptId);
        appendLiveStreamProbeText(conversationId, typed.text);
        return true;
    };

    const handleStreamDumpFrameMessage = (message: unknown): boolean => {
        const typed = message as StreamDumpFrameMessage | undefined;
        if (typed?.type !== MESSAGE_TYPES.STREAM_DUMP_FRAME) {
            return false;
        }
        if (
            typeof typed.attemptId !== 'string' ||
            typeof typed.platform !== 'string' ||
            typeof typed.text !== 'string' ||
            typeof typed.kind !== 'string'
        ) {
            return true;
        }
        if (!streamDumpEnabled || isStaleAttemptMessage(typed.attemptId, typed.conversationId, 'delta')) {
            return true;
        }
        void streamDumpStorage.saveFrame({
            platform: typed.platform,
            attemptId: typed.attemptId,
            conversationId: typed.conversationId,
            kind: typed.kind,
            text: typed.text,
            chunkBytes: typed.chunkBytes,
            frameIndex: typed.frameIndex,
            timestampMs: typed.timestampMs,
        });
        return true;
    };

    const handleConversationIdResolvedMessage = (message: unknown): boolean => {
        const typed = message as ConversationIdResolvedMessage | undefined;
        if (typed?.type !== MESSAGE_TYPES.CONVERSATION_ID_RESOLVED) {
            return false;
        }
        if (typeof typed.attemptId !== 'string' || typeof typed.conversationId !== 'string') {
            return false;
        }
        const canonicalAttemptId = resolveAliasedAttemptId(typed.attemptId);
        if (canonicalAttemptId !== typed.attemptId) {
            forwardAttemptAlias(typed.attemptId, canonicalAttemptId, 'rebound');
        }
        if (isStaleAttemptMessage(canonicalAttemptId, typed.conversationId, 'conversation-resolved')) {
            return true;
        }
        setActiveAttempt(canonicalAttemptId);
        setCurrentConversation(typed.conversationId);
        bindAttempt(typed.conversationId, canonicalAttemptId);
        sfe.getAttemptTracker().updateConversationId(canonicalAttemptId, typed.conversationId);
        const pending = pendingLifecycleByAttempt.get(canonicalAttemptId);
        if (pending) {
            pendingLifecycleByAttempt.delete(canonicalAttemptId);
            applyLifecyclePhaseForConversation(
                pending.phase,
                pending.platform,
                canonicalAttemptId,
                typed.conversationId,
                'replayed',
            );
        }
        refreshButtonState(typed.conversationId);
        return true;
    };

    const handleAttemptDisposedMessage = (message: unknown): boolean => {
        const typed = message as AttemptDisposedMessage | undefined;
        if (typed?.type !== MESSAGE_TYPES.ATTEMPT_DISPOSED || typeof typed.attemptId !== 'string') {
            return false;
        }
        const canonicalDisposedId = resolveAliasedAttemptId(typed.attemptId);
        cancelStreamDoneProbe(canonicalDisposedId, typed.reason === 'superseded' ? 'superseded' : 'disposed');
        clearCanonicalStabilizationRetry(canonicalDisposedId);
        sfe.dispose(canonicalDisposedId);
        pendingLifecycleByAttempt.delete(canonicalDisposedId);
        removePendingRunnerStreamPreview(streamPreviewState, canonicalDisposedId);
        for (const [conversationId, mappedAttemptId] of attemptByConversation.entries()) {
            if (shouldRemoveDisposedAttemptBinding(mappedAttemptId, canonicalDisposedId, resolveAliasedAttemptId)) {
                attemptByConversation.delete(conversationId);
            }
        }
        if (
            activeAttemptId &&
            shouldRemoveDisposedAttemptBinding(activeAttemptId, canonicalDisposedId, resolveAliasedAttemptId)
        ) {
            setActiveAttempt(null);
        }
        return true;
    };

    const handleJsonBridgeRequest = (message: unknown) => {
        const typedMessage = (message as { type?: unknown; requestId?: unknown; format?: unknown } | null) ?? null;
        if (typedMessage?.type !== MESSAGE_TYPES.GET_JSON_REQUEST || typeof typedMessage.requestId !== 'string') {
            return;
        }
        const requestId = typedMessage.requestId;
        const requestFormat = typedMessage.format === 'common' ? 'common' : 'original';
        getConversationData({ silent: true })
            .then((data) => {
                if (!data) {
                    window.postMessage(
                        stampToken({
                            type: MESSAGE_TYPES.GET_JSON_RESPONSE,
                            requestId,
                            success: false,
                            error: 'NO_CONVERSATION_DATA',
                        }),
                        window.location.origin,
                    );
                    return;
                }
                window.postMessage(
                    stampToken({
                        type: MESSAGE_TYPES.GET_JSON_RESPONSE,
                        requestId,
                        success: true,
                        data: buildExportPayloadForFormat(data, requestFormat),
                    }),
                    window.location.origin,
                );
            })
            .catch((error) => {
                logger.error('Failed to handle window get request:', error);
                window.postMessage(
                    stampToken({
                        type: MESSAGE_TYPES.GET_JSON_RESPONSE,
                        requestId,
                        success: false,
                        error: 'INTERNAL_ERROR',
                    }),
                    window.location.origin,
                );
            });
    };

    // Window bridge / completion watcher

    const isSameWindowOrigin = (event: MessageEvent): boolean =>
        event.source === window && event.origin === window.location.origin;

    const registerWindowBridge = (): (() => void) => {
        const handler = (event: MessageEvent) => {
            if (!isSameWindowOrigin(event)) {
                return;
            }
            const tokenFailureReason = resolveTokenValidationFailureReason(event.data);
            if (tokenFailureReason !== null) {
                const now = Date.now();
                if (now - lastInvalidSessionTokenLogAt > 1500) {
                    lastInvalidSessionTokenLogAt = now;
                    logger.debug('Dropped message due to session token validation failure', {
                        reason: tokenFailureReason,
                    });
                }
                return;
            }
            const handled = dispatchRunnerMessage(event.data, [
                handleAttemptDisposedMessage,
                handleConversationIdResolvedMessage,
                handleStreamDeltaMessage,
                handleStreamDumpFrameMessage,
                handleTitleResolvedMessage,
                handleLifecycleMessage,
                handleResponseFinishedMessage,
            ]);
            if (!handled) {
                handleJsonBridgeRequest(event.data);
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    };

    const registerCompletionWatcher = (): (() => void) => {
        if (currentAdapter?.name !== 'ChatGPT') {
            return () => {};
        }
        const isGenerating = () => isPlatformGenerating(currentAdapter);
        let wasGenerating = isGenerating();
        const checkTransition = () => {
            const generating = isGenerating();
            if (wasGenerating && !generating) {
                handleResponseFinished('dom');
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

    const registerButtonHealthCheck = (): (() => void) => {
        const healthCheckIntervalMs =
            typeof (window as any).__BLACKIYA_TEST_HEALTH_CHECK_INTERVAL_MS === 'number' &&
            Number.isFinite((window as any).__BLACKIYA_TEST_HEALTH_CHECK_INTERVAL_MS) &&
            (window as any).__BLACKIYA_TEST_HEALTH_CHECK_INTERVAL_MS > 0
                ? (window as any).__BLACKIYA_TEST_HEALTH_CHECK_INTERVAL_MS
                : 1800;
        const intervalId = window.setInterval(() => {
            if (!currentAdapter) {
                return;
            }
            const activeConversationId = extractConversationIdFromLocation();
            if (!activeConversationId) {
                refreshButtonState(undefined);
                return;
            }
            if (!buttonManager.exists()) {
                injectSaveButton();
                return;
            }
            refreshButtonState(activeConversationId);
        }, healthCheckIntervalMs);
        return () => clearInterval(intervalId);
    };

    // Navigation — delegates to navigation-handler module

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

    const buildNavigationDeps = (): NavigationDeps => ({
        getCurrentAdapter: () => currentAdapter,
        getCurrentConversationId: () => currentConversationId,
        getLifecycleState: () => lifecycleState,
        isLifecycleActiveGeneration,
        setCurrentConversation,
        setLifecycleState,
        updateAdapter: (adapter) => {
            currentAdapter = adapter;
            runnerState.adapter = adapter;
            interceptionManager.updateAdapter(adapter);
        },
        disposeInFlightAttempts: disposeInFlightAttemptsOnNavigation,
        buttonManagerRemove: () => buttonManager.remove(),
        buttonManagerExists: () => buttonManager.exists(),
        injectSaveButton,
        refreshButtonState,
        resetCalibrationPreference: () => {
            calibrationPreferenceLoaded = false;
            calibrationPreferenceLoading = null;
        },
        ensureCalibrationPreferenceLoaded,
        warmFetch: warmFetchConversationSnapshot,
        scheduleAutoCapture: maybeRunAutoCapture,
    });

    function handleNavigationChange() {
        handleNavigationChangeCore(buildNavigationDeps());
    }

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

    const storageChangeListener: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, areaName) => {
        if (areaName !== 'local') {
            return;
        }
        if (changes[STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_ENABLED]) {
            streamDumpEnabled = changes[STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_ENABLED]?.newValue === true;
            emitStreamDumpConfig();
        }
        if (changes[STORAGE_KEYS.STREAM_PROBE_VISIBLE]) {
            streamProbeVisible = changes[STORAGE_KEYS.STREAM_PROBE_VISIBLE]?.newValue === true;
            if (!streamProbeVisible) {
                removeStreamProbePanel();
            }
        }
        if (changes[STORAGE_KEYS.SFE_ENABLED]) {
            sfeEnabled = changes[STORAGE_KEYS.SFE_ENABLED]?.newValue !== false;
            refreshButtonState(currentConversationId ?? undefined);
        }
        if (changes[STORAGE_KEYS.CALIBRATION_PROFILES] && currentAdapter) {
            calibrationPreferenceLoaded = false;
            calibrationPreferenceLoading = null;
            autoCaptureAttempts.clear();
            autoCaptureDeferredLogged.clear();
            for (const timerId of autoCaptureRetryTimers.values()) {
                clearTimeout(timerId);
            }
            autoCaptureRetryTimers.clear();
            void ensureCalibrationPreferenceLoaded(currentAdapter.name);
        }
    };
    browser.storage.onChanged.addListener(storageChangeListener);

    interceptionManager.start();
    navigationManager.start();
    cleanupWindowBridge = registerWindowBridge();
    cleanupCompletionWatcher = registerCompletionWatcher();
    cleanupButtonHealthCheck = registerButtonHealthCheck();

    const handleVisibilityChange = () => {
        if (document.hidden) {
            return;
        }
        const conversationId = currentAdapter?.extractConversationId(window.location.href) ?? currentConversationId;
        if (!conversationId) {
            return;
        }
        if (resolveReadinessDecision(conversationId).mode === 'canonical_ready') {
            return;
        }
        logger.info('Tab became visible — reattempting capture', { conversationId });
        const attemptId = resolveAttemptId(conversationId);
        maybeRestartCanonicalRecoveryAfterTimeout(conversationId, attemptId);
        void requestPageSnapshot(conversationId).then((snapshot) => {
            if (!snapshot || !isConversationDataLike(snapshot)) {
                return;
            }
            interceptionManager.ingestConversationData(snapshot, 'visibility-recovery-snapshot');
            const cached = interceptionManager.getConversation(conversationId);
            if (!cached) {
                return;
            }
            if (evaluateReadinessForData(cached).ready) {
                markCanonicalCaptureMeta(conversationId);
                ingestSfeCanonicalSample(cached, attemptId);
            }
            refreshButtonState(conversationId);
        });
        void warmFetchConversationSnapshot(conversationId, 'force-save').then(() => {
            refreshButtonState(conversationId);
        });
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    setCurrentConversation(currentAdapter.extractConversationId(url));
    injectSaveButton();
    if (currentConversationId) {
        void warmFetchConversationSnapshot(currentConversationId, 'initial-load');
    }

    const retryIntervals = [1000, 2000, 5000];
    for (const delay of retryIntervals) {
        retryTimeoutIds.push(
            window.setTimeout(() => {
                if (!buttonManager.exists()) {
                    injectSaveButton();
                }
            }, delay),
        );
    }

    // Cleanup / teardown

    const cleanupRuntime = () => {
        if (cleanedUp) {
            return;
        }
        cleanedUp = true;
        try {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            const disposed = sfe.disposeAll();
            for (const attemptId of disposed) {
                cancelStreamDoneProbe(attemptId, 'teardown');
                clearCanonicalStabilizationRetry(attemptId);
                clearProbeLeaseRetry(attemptId);
                emitAttemptDisposed(attemptId, 'teardown');
            }
            interceptionManager.stop();
            navigationManager.stop();
            buttonManager.remove();
            cleanupWindowBridge?.();
            cleanupCompletionWatcher?.();
            cleanupButtonHealthCheck?.();
            browser.storage.onChanged.removeListener(storageChangeListener);
            for (const timerId of autoCaptureRetryTimers.values()) {
                clearTimeout(timerId);
            }
            autoCaptureRetryTimers.clear();
            for (const timerId of canonicalStabilizationRetryTimers.values()) {
                clearTimeout(timerId);
            }
            canonicalStabilizationRetryTimers.clear();
            canonicalStabilizationRetryCounts.clear();
            canonicalStabilizationStartedAt.clear();
            timeoutWarningByAttempt.clear();
            canonicalStabilizationInProgress.clear();
            for (const timerId of probeLeaseRetryTimers.values()) {
                clearTimeout(timerId);
            }
            probeLeaseRetryTimers.clear();
            for (const controller of streamProbeControllers.values()) {
                try {
                    controller.abort();
                } catch {
                    /* ignore */
                }
            }
            streamProbeControllers.clear();
            probeLease.dispose();
            for (const timeoutId of retryTimeoutIds) {
                clearTimeout(timeoutId);
            }
            retryTimeoutIds.length = 0;
            autoCaptureDeferredLogged.clear();
            if (beforeUnloadHandler) {
                window.removeEventListener('beforeunload', beforeUnloadHandler);
                beforeUnloadHandler = null;
            }
            const globalControl = (window as unknown as Record<string, unknown>)[RUNNER_CONTROL_KEY] as
                | RunnerControl
                | undefined;
            if (globalControl === runnerControl) {
                delete (window as unknown as Record<string, unknown>)[RUNNER_CONTROL_KEY];
            }
        } catch (error) {
            logger.debug('Error during cleanup:', error);
        }
    };

    beforeUnloadHandler = cleanupRuntime;
    window.addEventListener('beforeunload', cleanupRuntime);
    runnerControl.cleanup = cleanupRuntime;
};
