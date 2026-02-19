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
import {
    buildCalibrationProfileFromStep,
    loadCalibrationProfileV2IfPresent,
    saveCalibrationProfileV2,
    stepFromStrategy,
} from '@/utils/calibration-profile';
import { buildCommonExport } from '@/utils/common-export';
import { isConversationReady } from '@/utils/conversation-readiness';
import { streamDumpStorage } from '@/utils/diagnostics-stream-dump';
import { downloadAsJSON } from '@/utils/download';
import { hashText } from '@/utils/hash';
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
    type CalibrationCaptureDeps,
    captureFromRetries,
    isConversationDataLike,
    isRawCaptureSnapshot,
    type RawCaptureSnapshot,
    runCalibrationStep as runCalibrationStepPure,
} from '@/utils/runner/calibration-capture';
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
import { buildIsolatedDomSnapshot, buildRunnerSnapshotConversationData } from '@/utils/runner/dom-snapshot';
import {
    attachExportMeta,
    buildExportPayloadForFormat as buildExportPayloadForFormatPure,
} from '@/utils/runner/export-helpers';
import { applyResolvedExportTitle } from '@/utils/runner/export-pipeline';
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
import { shouldIngestAsCanonicalSample } from '@/utils/sfe/capture-fidelity';
import { CrossTabProbeLease } from '@/utils/sfe/cross-tab-probe-lease';
import { ReadinessGate } from '@/utils/sfe/readiness-gate';
import { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';
import type { ExportMeta, LifecyclePhase, PlatformReadiness, ReadinessDecision } from '@/utils/sfe/types';
import {
    deriveConversationTitleFromFirstUserMessage,
    resolveConversationTitleByPrecedence,
    resolveExportConversationTitleDecision as resolveExportTitleDecision,
} from '@/utils/title-resolver';
import type { ConversationData } from '@/utils/types';
import { ButtonManager } from '@/utils/ui/button-manager';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type LifecycleUiState = 'idle' | 'prompt-sent' | 'streaming' | 'completed';
type CalibrationUiState = 'idle' | 'waiting' | 'capturing' | 'success' | 'error';
type InterceptionCaptureMeta = { attemptId?: string; source?: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public re-exports (consumed by platform-runner.ts compat shim)
// ---------------------------------------------------------------------------

export { beginCanonicalStabilizationTick, clearCanonicalStabilizationAttemptState };
export type { CanonicalStabilizationAttemptState };
export { buildCalibrationOrderForMode, shouldPersistCalibrationProfile };

const normalizeContentText = (text: string): string => text.trim().normalize('NFC');

export const resolveExportConversationTitle = (data: ConversationData) => resolveExportTitleDecision(data).title;

export const shouldRemoveDisposedAttemptBinding = (
    mappedAttemptId: string,
    disposedAttemptId: string,
    resolveAttemptId: (attemptId: string) => string,
) => shouldRemoveDisposedAttemptBindingFromRegistry(mappedAttemptId, disposedAttemptId, resolveAttemptId);

export { resolveShouldSkipCanonicalRetryAfterAwait };

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Utility helpers
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Manager initialisation
    // -----------------------------------------------------------------------

    const buttonManager = new ButtonManager(handleSaveClick, handleCalibrationClick);

    const applyStreamResolvedTitleIfNeeded = (conversationId: string, data: ConversationData) => {
        const streamTitle = streamResolvedTitles.get(conversationId);
        if (streamTitle && data.title !== streamTitle) {
            data.title = streamTitle;
        }
    };

    const updateActiveAttemptFromMeta = (conversationId: string, meta?: InterceptionCaptureMeta) => {
        if (!meta?.attemptId) {
            return;
        }
        setActiveAttempt(meta.attemptId);
        bindAttempt(conversationId, meta.attemptId);
    };

    const handleSnapshotSourceCapture = (conversationId: string, source: string) => {
        const existingDecision = resolveReadinessDecision(conversationId);
        if (existingDecision.mode === 'canonical_ready') {
            markCanonicalCaptureMeta(conversationId);
        } else {
            markSnapshotCaptureMeta(conversationId);
        }
        const snapshotAttemptId = peekAttemptId(conversationId) ?? resolveAttemptId(conversationId);
        structuredLogger.emit(
            snapshotAttemptId,
            'info',
            'snapshot_degraded_mode_used',
            'Snapshot-based capture marked as degraded/manual-only',
            { conversationId, source },
            `snapshot-degraded:${conversationId}:${source}`,
        );
        if (lifecycleState === 'completed') {
            scheduleCanonicalStabilizationRetry(conversationId, snapshotAttemptId);
        }
    };

    const handleNetworkSourceCapture = (
        conversationId: string,
        meta?: InterceptionCaptureMeta,
        data?: ConversationData,
    ) => {
        if (!data) {
            return;
        }
        const source = meta?.source ?? 'network';
        const effectiveAttemptId = resolveAliasedAttemptId(meta?.attemptId ?? resolveAttemptId(conversationId));
        maybeRestartCanonicalRecoveryAfterTimeout(conversationId, effectiveAttemptId);
        logger.info('Network source: marking canonical fidelity', {
            conversationId,
            source,
            effectiveAttemptId,
            readinessReady: evaluateReadinessForData(data).ready,
        });
        markCanonicalCaptureMeta(conversationId);
        ingestSfeCanonicalSample(data, effectiveAttemptId);
    };

    const processInterceptionCapture = (capturedId: string, data: ConversationData, meta?: InterceptionCaptureMeta) => {
        applyStreamResolvedTitleIfNeeded(capturedId, data);
        setCurrentConversation(capturedId);
        updateActiveAttemptFromMeta(capturedId, meta);

        const source = meta?.source ?? 'network';
        if (source.includes('snapshot') || source.includes('dom')) {
            handleSnapshotSourceCapture(capturedId, source);
        } else {
            handleNetworkSourceCapture(capturedId, meta, data);
        }

        refreshButtonState(capturedId);
        if (evaluateReadinessForData(data).ready) {
            handleResponseFinished('network', capturedId);
        }
    };

    const interceptionManager = new InterceptionManager((capturedId, data, meta) => {
        processInterceptionCapture(capturedId, data, meta);
    });

    const navigationManager = new NavigationManager(() => {
        handleNavigationChange();
    });

    // -----------------------------------------------------------------------
    // Export format
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Attempt ID helpers
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Stream done probe
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Canonical stabilisation
    // -----------------------------------------------------------------------

    function clearCanonicalStabilizationRetry(attemptId: string) {
        const hadTimer = canonicalStabilizationRetryTimers.has(attemptId);
        if (hadTimer) {
            logger.info('Stabilization retry cleared', { attemptId });
        }
        clearCanonicalStabilizationAttemptState(attemptId, {
            timerIds: canonicalStabilizationRetryTimers,
            retryCounts: canonicalStabilizationRetryCounts,
            startedAt: canonicalStabilizationStartedAt,
            timeoutWarnings: timeoutWarningByAttempt,
            inProgress: canonicalStabilizationInProgress,
        });
    }

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

    function maybeRestartCanonicalRecoveryAfterTimeout(conversationId: string, attemptId: string) {
        if (!hasCanonicalStabilizationTimedOut(attemptId)) {
            return;
        }
        clearCanonicalStabilizationRetry(attemptId);
        const restarted = sfe.restartCanonicalRecovery(attemptId, Date.now());
        if (!restarted) {
            return;
        }
        structuredLogger.emit(
            attemptId,
            'info',
            'canonical_recovery_rearmed',
            'Re-armed canonical stabilization after timeout due to late canonical capture',
            { conversationId },
            `canonical-recovery-rearmed:${conversationId}`,
        );
    }

    function hasCanonicalStabilizationTimedOut(attemptId: string): boolean {
        const retries = canonicalStabilizationRetryCounts.get(attemptId) ?? 0;
        const hasPendingTimer = canonicalStabilizationRetryTimers.has(attemptId);
        if (retries >= CANONICAL_STABILIZATION_MAX_RETRIES && !hasPendingTimer) {
            if (!timeoutWarningByAttempt.has(attemptId)) {
                logger.info('Timeout: max retries exhausted with no pending timer', {
                    attemptId,
                    retries,
                    hasPendingTimer,
                    maxRetries: CANONICAL_STABILIZATION_MAX_RETRIES,
                });
            }
            return true;
        }
        if (hasPendingTimer) {
            return false;
        }
        const startedAt = canonicalStabilizationStartedAt.get(attemptId);
        if (!startedAt) {
            return false;
        }
        const timeoutMs =
            CANONICAL_STABILIZATION_RETRY_DELAY_MS * CANONICAL_STABILIZATION_MAX_RETRIES +
            CANONICAL_STABILIZATION_TIMEOUT_GRACE_MS;
        const elapsed = Date.now() - startedAt;
        if (elapsed >= timeoutMs && !timeoutWarningByAttempt.has(attemptId)) {
            logger.info('Timeout: elapsed exceeded max wait', { attemptId, retries, elapsed, timeoutMs });
        }
        return elapsed >= timeoutMs;
    }

    const tryPromoteReadySnapshotAsCanonical = async (
        conversationId: string,
        attemptId: string,
        retries: number,
        fetchSucceeded: boolean,
        readinessResult: PlatformReadiness,
    ): Promise<boolean> => {
        if (fetchSucceeded || !readinessResult.ready) {
            return false;
        }
        logger.info('Promoting ready snapshot to canonical (API unreachable)', {
            conversationId,
            retries: retries + 1,
        });
        markCanonicalCaptureMeta(conversationId);
        const cached = interceptionManager.getConversation(conversationId);
        if (!cached) {
            return false;
        }
        ingestSfeCanonicalSample(cached, attemptId);
        scheduleCanonicalStabilizationRetry(conversationId, attemptId);
        refreshButtonState(conversationId);
        return true;
    };

    const tryRefreshDegradedSnapshotAndPromote = async (
        conversationId: string,
        attemptId: string,
        retries: number,
        fetchSucceeded: boolean,
        readinessResult: PlatformReadiness,
    ): Promise<boolean> => {
        if (fetchSucceeded || readinessResult.ready) {
            return false;
        }
        logger.info('Snapshot promotion skipped: readiness check failed, re-requesting snapshot', {
            conversationId,
            retries: retries + 1,
            reason: readinessResult.reason,
            terminal: readinessResult.terminal,
        });
        const freshSnapshot = await requestPageSnapshot(conversationId);
        const freshData = freshSnapshot ?? resolveIsolatedSnapshotData(conversationId);
        if (!freshData) {
            return false;
        }
        ingestStabilizationRetrySnapshot(conversationId, freshData);
        const recheckCached = getReadyCachedConversation(conversationId);
        if (!recheckCached) {
            return false;
        }
        logger.info('Fresh snapshot promoted to canonical after re-request', { conversationId, retries: retries + 1 });
        markCanonicalCaptureMeta(conversationId);
        ingestSfeCanonicalSample(recheckCached, attemptId);
        scheduleCanonicalStabilizationRetry(conversationId, attemptId);
        refreshButtonState(conversationId);
        return true;
    };

    function getReadyCachedConversation(conversationId: string): ConversationData | null {
        const cached = interceptionManager.getConversation(conversationId);
        if (!cached) {
            return null;
        }
        return evaluateReadinessForData(cached).ready ? cached : null;
    }

    function resolveIsolatedSnapshotData(conversationId: string): ConversationData | null {
        if (!currentAdapter) {
            return null;
        }
        return buildIsolatedDomSnapshot(currentAdapter, conversationId);
    }

    function ingestStabilizationRetrySnapshot(
        conversationId: string,
        freshData: ConversationData | RawCaptureSnapshot | unknown,
    ) {
        if (isConversationDataLike(freshData)) {
            interceptionManager.ingestConversationData(freshData, 'stabilization-retry-snapshot');
            return;
        }
        interceptionManager.ingestInterceptedData({
            url: `stabilization-retry-snapshot://${currentAdapter?.name ?? 'unknown'}/${conversationId}`,
            data: JSON.stringify(freshData),
            platform: currentAdapter?.name ?? 'unknown',
        });
    }

    const handleDegradedCanonicalCandidate = async (
        conversationId: string,
        attemptId: string,
        retries: number,
        fetchSucceeded: boolean,
        cached: ConversationData,
    ) => {
        const readinessResult = evaluateReadinessForData(cached);
        if (
            await tryPromoteReadySnapshotAsCanonical(
                conversationId,
                attemptId,
                retries,
                fetchSucceeded,
                readinessResult,
            )
        ) {
            return;
        }
        if (
            await tryRefreshDegradedSnapshotAndPromote(
                conversationId,
                attemptId,
                retries,
                fetchSucceeded,
                readinessResult,
            )
        ) {
            return;
        }
        scheduleCanonicalStabilizationRetry(conversationId, attemptId);
        refreshButtonState(conversationId);
    };

    const shouldSkipCanonicalRetryTick = (conversationId: string, attemptId: string, retries: number): boolean => {
        const disposed = isAttemptDisposedOrSuperseded(attemptId);
        const mappedAttempt = attemptByConversation.get(conversationId);
        const mappedMismatch = !!mappedAttempt && mappedAttempt !== attemptId;
        logger.info('Stabilization retry tick', {
            conversationId,
            attemptId,
            retries,
            disposed,
            mappedMismatch,
            sfePhase: sfe.resolve(attemptId).phase,
        });
        return disposed || mappedMismatch;
    };

    const shouldSkipCanonicalRetryAfterAwait = (conversationId: string, attemptId: string): boolean => {
        const mappedAttempt = attemptByConversation.get(conversationId);
        const disposedOrSuperseded = isAttemptDisposedOrSuperseded(attemptId);
        const shouldSkip = resolveShouldSkipCanonicalRetryAfterAwait(
            attemptId,
            disposedOrSuperseded,
            mappedAttempt,
            resolveAliasedAttemptId,
        );
        if (!shouldSkip) {
            return false;
        }
        logger.info('Stabilization retry skip after await', {
            conversationId,
            attemptId,
            disposedOrSuperseded,
            mappedAttempt: mappedAttempt ?? null,
        });
        return true;
    };

    const processCanonicalStabilizationRetryTick = async (
        conversationId: string,
        attemptId: string,
        retries: number,
    ) => {
        if (!beginCanonicalStabilizationTick(attemptId, canonicalStabilizationInProgress)) {
            logger.info('Stabilization retry tick skipped: already in progress', { conversationId, attemptId });
            return;
        }
        try {
            canonicalStabilizationRetryTimers.delete(attemptId);
            canonicalStabilizationRetryCounts.set(attemptId, retries + 1);
            if (shouldSkipCanonicalRetryTick(conversationId, attemptId, retries)) {
                return;
            }
            const fetchSucceeded = await warmFetchConversationSnapshot(conversationId, 'stabilization-retry');
            if (shouldSkipCanonicalRetryAfterAwait(conversationId, attemptId)) {
                return;
            }
            const cached = interceptionManager.getConversation(conversationId);
            if (!cached) {
                scheduleCanonicalStabilizationRetry(conversationId, attemptId);
                return;
            }
            const captureMeta = getCaptureMeta(conversationId);
            if (!shouldIngestAsCanonicalSample(captureMeta)) {
                await handleDegradedCanonicalCandidate(conversationId, attemptId, retries, fetchSucceeded, cached);
                if (shouldSkipCanonicalRetryAfterAwait(conversationId, attemptId)) {
                    return;
                }
                return;
            }
            ingestSfeCanonicalSample(cached, attemptId);
            refreshButtonState(conversationId);
        } finally {
            canonicalStabilizationInProgress.delete(attemptId);
        }
    };

    function scheduleCanonicalStabilizationRetry(conversationId: string, attemptId: string) {
        if (canonicalStabilizationRetryTimers.has(attemptId)) {
            logger.info('Stabilization retry already scheduled (skip)', { conversationId, attemptId });
            return;
        }
        if (isAttemptDisposedOrSuperseded(attemptId)) {
            logger.info('Stabilization retry skip: attempt disposed/superseded', { conversationId, attemptId });
            return;
        }
        const retries = canonicalStabilizationRetryCounts.get(attemptId) ?? 0;
        if (retries >= CANONICAL_STABILIZATION_MAX_RETRIES) {
            structuredLogger.emit(
                attemptId,
                'warn',
                'canonical_stabilization_retry_exhausted',
                'Canonical stabilization retries exhausted',
                { conversationId, retries },
                `canonical-stability-exhausted:${conversationId}:${retries}`,
            );
            return;
        }
        if (!canonicalStabilizationStartedAt.has(attemptId)) {
            canonicalStabilizationStartedAt.set(attemptId, Date.now());
        }
        const timerId = window.setTimeout(() => {
            void processCanonicalStabilizationRetryTick(conversationId, attemptId, retries);
        }, CANONICAL_STABILIZATION_RETRY_DELAY_MS);
        canonicalStabilizationRetryTimers.set(attemptId, timerId);
        logger.info('Stabilization retry scheduled', {
            conversationId,
            attemptId,
            retryNumber: retries + 1,
            delayMs: CANONICAL_STABILIZATION_RETRY_DELAY_MS,
        });
    }

    // -----------------------------------------------------------------------
    // Readiness evaluation
    // -----------------------------------------------------------------------

    function evaluateReadinessForData(data: ConversationData): PlatformReadiness {
        if (!data || !data.mapping || typeof data.mapping !== 'object') {
            return {
                ready: false,
                terminal: false,
                reason: 'invalid-conversation-shape',
                contentHash: null,
                latestAssistantTextLength: 0,
            };
        }
        if (currentAdapter?.evaluateReadiness) {
            return currentAdapter.evaluateReadiness(data);
        }
        const assistantMessages = Object.values(data.mapping)
            .map((node) => node?.message)
            .filter((msg): msg is NonNullable<(typeof data.mapping)[string]['message']> => !!msg)
            .filter((msg) => msg.author.role === 'assistant');
        const latestAssistant = assistantMessages[assistantMessages.length - 1];
        const text = normalizeContentText((latestAssistant?.content.parts ?? []).join(''));
        const hasInProgress = assistantMessages.some((msg) => msg.status === 'in_progress');
        const terminal = !hasInProgress;
        return {
            ready: isConversationReady(data),
            terminal,
            reason: terminal ? 'terminal-snapshot' : 'assistant-in-progress',
            contentHash: text.length > 0 ? hashText(text) : null,
            latestAssistantTextLength: text.length,
        };
    }

    // -----------------------------------------------------------------------
    // SFE ingestion
    // -----------------------------------------------------------------------

    const ingestSfeLifecycle = (phase: LifecyclePhase, attemptId: string, conversationId?: string | null) => {
        if (!sfeEnabled) {
            return;
        }
        const resolution = sfe.ingestSignal({
            attemptId,
            platform: currentAdapter?.name ?? 'Unknown',
            source: phase === 'completed_hint' ? 'completion_endpoint' : 'network_stream',
            phase,
            conversationId,
            timestampMs: Date.now(),
        });
        if (conversationId) {
            bindAttempt(conversationId, attemptId);
        }
        if (phase === 'completed_hint') {
            structuredLogger.emit(
                attemptId,
                'info',
                'completed_hint_received',
                'SFE completed hint received',
                { conversationId: conversationId ?? null },
                `completed:${conversationId ?? 'unknown'}`,
            );
        }
        structuredLogger.emit(
            attemptId,
            'debug',
            'sfe_phase_update',
            'SFE lifecycle phase update',
            { phase: resolution.phase, ready: resolution.ready, conversationId: conversationId ?? null },
            `phase:${resolution.phase}:${conversationId ?? 'unknown'}`,
        );
    };

    const emitCanonicalSampleProcessed = (
        attemptId: string,
        conversationId: string,
        resolution: ReturnType<SignalFusionEngine['applyCanonicalSample']>,
        readiness: PlatformReadiness,
    ) => {
        structuredLogger.emit(
            attemptId,
            'debug',
            readiness.contentHash ? 'canonical_probe_sample_changed' : 'canonical_probe_started',
            'SFE canonical sample processed',
            {
                conversationId,
                phase: resolution.phase,
                ready: resolution.ready,
                blockingConditions: resolution.blockingConditions,
            },
            `canonical:${conversationId}:${readiness.contentHash ?? 'none'}`,
        );
    };

    const shouldScheduleCanonicalRetry = (
        resolution: ReturnType<SignalFusionEngine['applyCanonicalSample']>,
        activeLifecycleState: LifecycleUiState,
    ): boolean => {
        const hitStabilizationTimeout = resolution.blockingConditions.includes('stabilization_timeout');
        return (
            !resolution.ready &&
            !hitStabilizationTimeout &&
            activeLifecycleState === 'completed' &&
            (resolution.reason === 'awaiting_stabilization' || resolution.reason === 'captured_not_ready')
        );
    };

    function ingestSfeCanonicalSample(
        data: ConversationData,
        attemptId?: string,
    ): ReturnType<SignalFusionEngine['applyCanonicalSample']> | null {
        if (!sfeEnabled) {
            return null;
        }
        const conversationId = data.conversation_id;
        const effectiveAttemptId = attemptId ?? resolveAttemptId(conversationId);
        bindAttempt(conversationId, effectiveAttemptId);
        const readiness = evaluateReadinessForData(data);
        const resolution = sfe.applyCanonicalSample({
            attemptId: effectiveAttemptId,
            platform: currentAdapter?.name ?? 'Unknown',
            conversationId,
            data,
            readiness,
            timestampMs: Date.now(),
        });
        emitCanonicalSampleProcessed(effectiveAttemptId, conversationId, resolution, readiness);
        const shouldRetry = shouldScheduleCanonicalRetry(resolution, lifecycleState);
        if (!shouldRetry && !resolution.ready) {
            logger.info('Canonical retry skipped', {
                conversationId,
                lifecycleState,
                reason: resolution.reason,
                blocking: resolution.blockingConditions,
            });
        }
        if (shouldRetry) {
            scheduleCanonicalStabilizationRetry(conversationId, effectiveAttemptId);
            structuredLogger.emit(
                effectiveAttemptId,
                'info',
                resolution.reason === 'awaiting_stabilization'
                    ? 'awaiting_stabilization'
                    : 'awaiting_canonical_capture',
                resolution.reason === 'awaiting_stabilization'
                    ? 'Awaiting canonical stabilization before ready'
                    : 'Completed stream but canonical sample not terminal yet; scheduling retries',
                { conversationId, phase: resolution.phase },
                `${resolution.reason === 'awaiting_stabilization' ? 'awaiting-stabilization' : 'awaiting-canonical'}:${conversationId}:${readiness.contentHash ?? 'none'}`,
            );
        }
        if (resolution.blockingConditions.includes('stabilization_timeout')) {
            clearCanonicalStabilizationRetry(effectiveAttemptId);
        }
        if (resolution.ready) {
            clearCanonicalStabilizationRetry(effectiveAttemptId);
            syncStreamProbePanelFromCanonical(conversationId, data);
            structuredLogger.emit(
                effectiveAttemptId,
                'info',
                'captured_ready',
                'Capture reached ready state',
                { conversationId, phase: resolution.phase },
                `captured-ready:${conversationId}`,
            );
        }
        return resolution;
    }

    const resolveSfeReady = (conversationId: string): boolean => {
        const resolution = sfe.resolveByConversation(conversationId);
        return !!resolution?.ready;
    };

    const logSfeMismatchIfNeeded = (conversationId: string, legacyReady: boolean) => {
        if (!sfeEnabled) {
            return;
        }
        const attemptId = peekAttemptId(conversationId) ?? 'unknown';
        const sfeReady = resolveSfeReady(conversationId);
        if (legacyReady === sfeReady) {
            return;
        }
        structuredLogger.emit(
            attemptId,
            'info',
            'legacy_sfe_mismatch',
            'Legacy/SFE readiness mismatch',
            { conversationId, legacyReady, sfeReady },
            `mismatch:${conversationId}:${legacyReady}:${sfeReady}`,
        );
    };

    function emitAttemptDisposed(attemptId: string, reason: AttemptDisposedMessage['reason']) {
        pendingLifecycleByAttempt.delete(attemptId);
        structuredLogger.emit(
            attemptId,
            'info',
            'attempt_disposed',
            'Attempt disposed',
            { reason },
            `attempt-disposed:${reason}`,
        );
        const payload: AttemptDisposedMessage = { type: MESSAGE_TYPES.ATTEMPT_DISPOSED, attemptId, reason };
        window.postMessage(stampToken(payload), window.location.origin);
    }

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

    // -----------------------------------------------------------------------
    // Stream probe panel (delegates to probe-panel module)
    // -----------------------------------------------------------------------

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
        const cachedText = extractResponseTextForProbe(data);
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

    // -----------------------------------------------------------------------
    // Common export text extraction (for probe display)
    // -----------------------------------------------------------------------

    function extractResponseTextForProbe(data: ConversationData): string {
        try {
            const common = buildCommonExport(data, currentAdapter?.name ?? 'Unknown') as {
                response?: string | null;
                prompt?: string | null;
            };
            const response = (common.response ?? '').trim();
            const prompt = (common.prompt ?? '').trim();
            if (response) {
                return response;
            }
            if (prompt) {
                return `(No assistant response found yet)\nPrompt: ${prompt}`;
            }
        } catch {
            // fall through
        }
        return Object.values(data.mapping)
            .map((node) => node.message)
            .filter((msg): msg is NonNullable<(typeof data.mapping)[string]['message']> => !!msg)
            .filter((msg) => msg.author.role === 'assistant')
            .flatMap((msg) => msg.content.parts ?? [])
            .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
            .join('\n\n')
            .trim();
    }

    // Lazy import so buildCommonExport doesn't need to be imported at module level
    // purely for the probe display path.
    const buildCommonExportForProbe = (data: ConversationData): unknown => {
        const { buildCommonExport } = require('@/utils/common-export');
        return buildCommonExport(data, currentAdapter?.name ?? 'Unknown');
    };

    // -----------------------------------------------------------------------
    // Stream done probe
    // -----------------------------------------------------------------------

    type StreamDoneProbeContext = {
        adapter: LLMPlatform;
        conversationId: string;
        attemptId: string;
        probeKey: string;
        controller: AbortController;
    };

    const createStreamDoneProbeContext = async (
        conversationId: string,
        hintedAttemptId?: string,
    ): Promise<StreamDoneProbeContext | null> => {
        if (!currentAdapter) {
            return null;
        }
        const attemptId = hintedAttemptId ?? resolveAttemptId(conversationId);
        if (isAttemptDisposedOrSuperseded(attemptId)) {
            return null;
        }
        if (!(await tryAcquireProbeLease(conversationId, attemptId))) {
            return null;
        }
        cancelStreamDoneProbe(attemptId, 'superseded');
        const controller = new AbortController();
        streamProbeControllers.set(attemptId, controller);
        return {
            adapter: currentAdapter,
            conversationId,
            attemptId,
            probeKey: `${currentAdapter.name}:${conversationId}:${Date.now()}`,
            controller,
        };
    };

    const tryStreamDoneSnapshotCapture = async (conversationId: string, attemptId: string): Promise<boolean> => {
        if (!currentAdapter || isAttemptDisposedOrSuperseded(attemptId)) {
            return false;
        }
        logger.info('Stream done snapshot fallback requested', { platform: currentAdapter.name, conversationId });
        const snapshot = await requestPageSnapshot(conversationId);
        const fallback = snapshot ?? resolveIsolatedSnapshotData(conversationId);
        if (!fallback) {
            return false;
        }
        try {
            ingestStreamDoneSnapshot(conversationId, fallback);
        } catch {
            return false;
        }
        const cached = interceptionManager.getConversation(conversationId);
        const captured = !!cached && evaluateReadinessForData(cached).ready;
        if (captured) {
            logger.info('Stream done snapshot fallback captured', { platform: currentAdapter.name, conversationId });
        }
        return captured;
    };

    function ingestStreamDoneSnapshot(
        conversationId: string,
        snapshot: ConversationData | RawCaptureSnapshot | unknown,
    ) {
        if (!currentAdapter) {
            return;
        }
        if (isConversationDataLike(snapshot)) {
            interceptionManager.ingestConversationData(snapshot, 'stream-done-snapshot');
            return;
        }
        if (isRawCaptureSnapshot(snapshot)) {
            for (const replayUrl of getRawSnapshotReplayUrls(currentAdapter, conversationId, snapshot)) {
                interceptionManager.ingestInterceptedData({
                    url: replayUrl,
                    data: snapshot.data,
                    platform: snapshot.platform ?? currentAdapter.name,
                });
                const cached = interceptionManager.getConversation(conversationId);
                if (cached && evaluateReadinessForData(cached).ready) {
                    break;
                }
            }
            return;
        }
        interceptionManager.ingestInterceptedData({
            url: `stream-snapshot://${currentAdapter.name}/${conversationId}`,
            data: JSON.stringify(snapshot),
            platform: currentAdapter.name,
        });
    }

    const setStreamDonePanelWithMirror = (conversationId: string, title: string, body: string) =>
        setStreamProbePanel(title, withPreservedLiveMirrorSnapshot(conversationId, title, body));

    async function runStreamDoneProbe(conversationId: string, hintedAttemptId?: string) {
        const context = await createStreamDoneProbeContext(conversationId, hintedAttemptId);
        if (!context) {
            return;
        }
        try {
            lastStreamProbeKey = context.probeKey;
            lastStreamProbeConversationId = context.conversationId;
            setStreamProbePanel('stream-done: fetching conversation', `conversationId=${context.conversationId}`);
            logger.info('Stream done probe start', {
                platform: context.adapter.name,
                conversationId: context.conversationId,
            });

            const apiUrls = getFetchUrlCandidates(context.adapter, context.conversationId);
            if (apiUrls.length === 0) {
                await handleStreamDoneNoCandidates(context);
                return;
            }
            const succeeded = await tryRunStreamDoneCandidateFetches(context, apiUrls);
            if (!succeeded) {
                await tryShowStreamDoneFallbackPanel(context);
                logger.warn('Stream done probe failed', {
                    platform: context.adapter.name,
                    conversationId: context.conversationId,
                });
            }
        } finally {
            streamProbeControllers.delete(context.attemptId);
            void probeLease.release(context.conversationId, context.attemptId).catch((error) => {
                logger.debug('Probe lease release failed', {
                    conversationId: context.conversationId,
                    attemptId: context.attemptId,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }
    }

    const handleStreamDoneNoCandidates = async (context: StreamDoneProbeContext) => {
        const captured = await tryStreamDoneSnapshotCapture(context.conversationId, context.attemptId);
        if (captured) {
            const cached = interceptionManager.getConversation(context.conversationId);
            const body = cached
                ? extractResponseTextForProbe(cached) || '(captured via snapshot fallback)'
                : '(captured via snapshot fallback)';
            setStreamDonePanelWithMirror(
                context.conversationId,
                'stream-done: degraded snapshot captured',
                `${body}\n\nAwaiting canonical capture. Force Save appears only if stabilization times out.`,
            );
            return;
        }
        setStreamDonePanelWithMirror(
            context.conversationId,
            'stream-done: no api url candidates',
            `conversationId=${context.conversationId}`,
        );
        logger.warn('Stream done probe has no URL candidates', {
            platform: context.adapter.name,
            conversationId: context.conversationId,
        });
    };

    const tryRunStreamDoneCandidateFetches = async (
        context: StreamDoneProbeContext,
        apiUrls: string[],
    ): Promise<boolean> => {
        for (const apiUrl of apiUrls) {
            if (context.controller.signal.aborted || isAttemptDisposedOrSuperseded(context.attemptId)) {
                return true;
            }
            try {
                const response = await fetch(apiUrl, { credentials: 'include', signal: context.controller.signal });
                if (!response.ok) {
                    continue;
                }
                const text = await response.text();
                const parsed = context.adapter.parseInterceptedData(text, apiUrl);
                if (!parsed?.conversation_id || parsed.conversation_id !== context.conversationId) {
                    continue;
                }
                const body = extractResponseTextForProbe(parsed) || '(empty response text)';
                if (lastStreamProbeKey === context.probeKey) {
                    setStreamDonePanelWithMirror(context.conversationId, 'stream-done: fetched full text', body);
                }
                logger.info('Stream done probe success', {
                    platform: context.adapter.name,
                    conversationId: context.conversationId,
                    textLength: body.length,
                });
                return true;
            } catch {
                // try next candidate
            }
        }
        return false;
    };

    const tryShowStreamDoneFallbackPanel = async (context: StreamDoneProbeContext) => {
        if (lastStreamProbeKey !== context.probeKey) {
            return;
        }
        const cached = interceptionManager.getConversation(context.conversationId);
        if (cached && evaluateReadinessForData(cached).ready) {
            const cachedText = extractResponseTextForProbe(cached);
            const body = cachedText.length > 0 ? cachedText : '(captured cache ready; no assistant text extracted)';
            setStreamDonePanelWithMirror(context.conversationId, 'stream-done: using captured cache', body);
            return;
        }
        const capturedFromSnapshot = await tryStreamDoneSnapshotCapture(context.conversationId, context.attemptId);
        if (capturedFromSnapshot) {
            const snapshotCached = interceptionManager.getConversation(context.conversationId);
            const snapshotText = snapshotCached ? extractResponseTextForProbe(snapshotCached) : '';
            const snapshotBody = snapshotText.length > 0 ? snapshotText : '(captured via snapshot fallback)';
            setStreamDonePanelWithMirror(
                context.conversationId,
                'stream-done: degraded snapshot captured',
                `${snapshotBody}\n\nAwaiting canonical capture. Force Save appears only if stabilization times out.`,
            );
            return;
        }
        setStreamDonePanelWithMirror(
            context.conversationId,
            'stream-done: awaiting canonical capture',
            `Conversation stream completed for ${context.conversationId}. Waiting for canonical capture.`,
        );
    };

    // -----------------------------------------------------------------------
    // Export pipeline (delegates to export-helpers module)
    // -----------------------------------------------------------------------

    const buildExportPayloadForFormat = (data: ConversationData, format: ExportFormat): unknown =>
        buildExportPayloadForFormatPure(data, format, currentAdapter?.name ?? 'Unknown');

    const buildExportPayload = async (data: ConversationData, meta: ExportMeta): Promise<unknown> => {
        const format = await getExportFormat();
        return attachExportMeta(buildExportPayloadForFormat(data, format), meta);
    };

    // -----------------------------------------------------------------------
    // Save readiness and force-save
    // -----------------------------------------------------------------------

    const resolveSaveReadiness = (
        conversationId: string | null,
    ): { conversationId: string; decision: ReadinessDecision; allowDegraded: boolean } | null => {
        if (!conversationId) {
            return null;
        }
        const decision = resolveReadinessDecision(conversationId);
        return { conversationId, decision, allowDegraded: decision.mode === 'degraded_manual_only' };
    };

    const maybeIngestFreshSnapshotForForceSave = (conversationId: string, freshSnapshot: unknown): boolean => {
        if (!freshSnapshot || !isConversationDataLike(freshSnapshot)) {
            return false;
        }
        interceptionManager.ingestConversationData(freshSnapshot, 'force-save-snapshot-recovery');
        const cached = interceptionManager.getConversation(conversationId);
        if (!cached) {
            return false;
        }
        if (!evaluateReadinessForData(cached).ready) {
            return false;
        }
        markCanonicalCaptureMeta(conversationId);
        ingestSfeCanonicalSample(cached, resolveAttemptId(conversationId));
        refreshButtonState(conversationId);
        logger.info('Force Save recovered via fresh snapshot — using canonical path', { conversationId });
        return true;
    };

    const recoverCanonicalBeforeForceSave = async (conversationId: string): Promise<boolean> => {
        const freshSnapshot = await requestPageSnapshot(conversationId);
        if (maybeIngestFreshSnapshotForForceSave(conversationId, freshSnapshot)) {
            return true;
        }
        await warmFetchConversationSnapshot(conversationId, 'force-save');
        refreshButtonState(conversationId);
        return resolveReadinessDecision(conversationId).mode !== 'degraded_manual_only';
    };

    const confirmDegradedForceSave = (): boolean => {
        if (typeof window.confirm !== 'function') {
            return true;
        }
        return window.confirm('Force Save may export partial data because canonical capture timed out. Continue?');
    };

    // -----------------------------------------------------------------------
    // Save / calibration click handlers
    // -----------------------------------------------------------------------

    async function handleSaveClick() {
        if (!currentAdapter) {
            return;
        }
        const readiness = resolveSaveReadiness(resolveConversationIdForUserAction());
        if (!readiness) {
            return;
        }
        let allowDegraded = readiness.allowDegraded;
        if (allowDegraded) {
            const recovered = await recoverCanonicalBeforeForceSave(readiness.conversationId);
            allowDegraded = !recovered;
        }
        if (allowDegraded && !confirmDegradedForceSave()) {
            return;
        }
        const data = await getConversationData({ allowDegraded });
        if (!data) {
            return;
        }
        await saveConversation(data, { allowDegraded });
    }

    async function handleCalibrationClick() {
        if (calibrationState === 'capturing') {
            return;
        }
        if (calibrationState === 'waiting') {
            await runCalibrationCapture('manual');
            return;
        }
        setCalibrationStatus('waiting');
        logger.info('Calibration armed. Click Done when response is complete.');
    }

    function setCalibrationStatus(status: 'idle' | 'waiting' | 'capturing' | 'success' | 'error') {
        calibrationState = status;
        runnerState.calibrationState = status;
        buttonManager.setCalibrationState(status, {
            timestampLabel:
                status === 'success' ? formatCalibrationTimestampLabel(rememberedCalibrationUpdatedAt) : null,
        });
    }

    const markCalibrationSuccess = (conversationId: string) => {
        setCalibrationStatus('success');
        refreshButtonState(conversationId);
    };

    // -----------------------------------------------------------------------
    // URL candidate helpers
    // -----------------------------------------------------------------------

    function getFetchUrlCandidates(adapter: LLMPlatform, conversationId: string): string[] {
        const urls: string[] = [];
        for (const url of adapter.buildApiUrls?.(conversationId) ?? []) {
            if (typeof url === 'string' && url.length > 0 && !urls.includes(url)) {
                urls.push(url);
            }
        }
        const primary = adapter.buildApiUrl?.(conversationId);
        if (primary && !urls.includes(primary)) {
            urls.unshift(primary);
        }
        const currentOrigin = window.location.origin;
        return urls.filter((url) => {
            try {
                return new URL(url, currentOrigin).origin === currentOrigin;
            } catch {
                return false;
            }
        });
    }

    function getRawSnapshotReplayUrls(
        adapter: LLMPlatform,
        conversationId: string,
        rawSnapshot: { url: string },
    ): string[] {
        const urls = [rawSnapshot.url];
        if (adapter.name !== 'Grok') {
            return urls;
        }
        for (const candidate of [
            `https://grok.com/rest/app-chat/conversations/${conversationId}/load-responses`,
            `https://grok.com/rest/app-chat/conversations/${conversationId}/response-node?includeThreads=true`,
            `https://grok.com/rest/app-chat/conversations_v2/${conversationId}?includeWorkspaces=true&includeTaskResult=true`,
        ]) {
            if (!urls.includes(candidate)) {
                urls.push(candidate);
            }
        }
        return urls;
    }

    // -----------------------------------------------------------------------
    // Warm fetch (delegates to warm-fetch module)
    // -----------------------------------------------------------------------

    const buildWarmFetchDeps = (): WarmFetchDeps => ({
        platformName: currentAdapter?.name ?? 'Unknown',
        getFetchUrlCandidates: (conversationId) =>
            currentAdapter ? getFetchUrlCandidates(currentAdapter, conversationId) : [],
        ingestInterceptedData: (args) => interceptionManager.ingestInterceptedData(args),
        getConversation: (conversationId) => interceptionManager.getConversation(conversationId),
        evaluateReadiness: (data) => evaluateReadinessForData(data),
        getCaptureMeta: (conversationId) => getCaptureMeta(conversationId),
    });

    const warmFetchConversationSnapshot = (conversationId: string, reason: WarmFetchReason): Promise<boolean> =>
        warmFetchConversationSnapshotCore(conversationId, reason, buildWarmFetchDeps(), warmFetchInFlight);

    // -----------------------------------------------------------------------
    // Calibration capture (delegates to calibration-capture module)
    // -----------------------------------------------------------------------

    const buildCalibrationCaptureDeps = (conversationId: string): CalibrationCaptureDeps => ({
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

    // -----------------------------------------------------------------------
    // Calibration orchestration
    // -----------------------------------------------------------------------

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

    const loadCalibrationPreference = async (platformName: string) => {
        try {
            const profileV2 = await loadCalibrationProfileV2IfPresent(platformName);
            if (profileV2) {
                rememberedPreferredStep = stepFromStrategy(profileV2.strategy);
                rememberedCalibrationUpdatedAt = profileV2.updatedAt;
            } else {
                rememberedPreferredStep = null;
                rememberedCalibrationUpdatedAt = null;
            }
            calibrationPreferenceLoaded = true;
            syncCalibrationButtonDisplay();
        } catch (error) {
            logger.warn('Failed to load calibration profile', error);
            calibrationPreferenceLoaded = true;
            syncCalibrationButtonDisplay();
        }
    };

    const ensureCalibrationPreferenceLoaded = (platformName: string): Promise<void> => {
        if (calibrationPreferenceLoaded) {
            return Promise.resolve();
        }
        if (calibrationPreferenceLoading) {
            return calibrationPreferenceLoading;
        }
        calibrationPreferenceLoading = loadCalibrationPreference(platformName).finally(() => {
            calibrationPreferenceLoading = null;
        });
        return calibrationPreferenceLoading;
    };

    const rememberCalibrationSuccess = async (platformName: string, step: CalibrationStep) => {
        try {
            rememberedPreferredStep = step;
            rememberedCalibrationUpdatedAt = new Date().toISOString();
            calibrationPreferenceLoaded = true;
            await saveCalibrationProfileV2(buildCalibrationProfileFromStep(platformName, step));
        } catch (error) {
            logger.warn('Failed to save calibration profile', error);
        }
    };

    const resolveDisplayedCalibrationState = (_conversationId: string | null): CalibrationUiState => {
        if (calibrationState === 'idle' && !!rememberedPreferredStep) {
            return 'success';
        }
        return calibrationState;
    };

    function syncCalibrationButtonDisplay() {
        if (!buttonManager.exists() || !currentAdapter) {
            return;
        }
        const conversationId = currentAdapter.extractConversationId(window.location.href);
        const displayState = resolveDisplayedCalibrationState(conversationId);
        buttonManager.setCalibrationState(displayState, {
            timestampLabel:
                displayState === 'success' ? formatCalibrationTimestampLabel(rememberedCalibrationUpdatedAt) : null,
        });
    }

    function formatCalibrationTimestampLabel(updatedAt: string | null): string | null {
        if (!updatedAt) {
            return null;
        }
        const parsed = new Date(updatedAt);
        if (Number.isNaN(parsed.getTime())) {
            return null;
        }
        const now = Date.now();
        const ageMs = Math.max(0, now - parsed.getTime());
        const minuteMs = 60_000;
        const hourMs = 60 * minuteMs;
        const dayMs = 24 * hourMs;
        if (ageMs < minuteMs) {
            return 'just now';
        }
        if (ageMs < hourMs) {
            return `${Math.floor(ageMs / minuteMs)}m ago`;
        }
        if (ageMs < dayMs) {
            return `${Math.floor(ageMs / hourMs)}h ago`;
        }
        return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    const isCalibrationCaptureSatisfied = (conversationId: string, mode: CalibrationMode): boolean => {
        if (mode === 'auto') {
            return isConversationReadyForActions(conversationId);
        }
        return !!interceptionManager.getConversation(conversationId);
    };

    async function runCalibrationCapture(mode: CalibrationMode = 'manual', hintedConversationId?: string) {
        if (calibrationState === 'capturing' || !currentAdapter) {
            return;
        }
        const conversationId = hintedConversationId || currentAdapter.extractConversationId(window.location.href);
        if (!conversationId) {
            logger.warn('Calibration failed: no conversation ID');
            setCalibrationStatus('error');
            return;
        }

        setCalibrationStatus('capturing');
        logger.info('Calibration capture started', { conversationId, platform: currentAdapter.name });
        const strategyOrder = buildCalibrationOrderForMode(rememberedPreferredStep, mode, currentAdapter.name);
        logger.info('Calibration strategy', {
            platform: currentAdapter.name,
            steps: strategyOrder,
            mode,
            remembered: rememberedPreferredStep,
        });

        let successfulStep: CalibrationStep | null = null;
        for (const step of strategyOrder) {
            if (await runCalibrationStep(step, conversationId, mode)) {
                successfulStep = step;
                break;
            }
        }

        if (successfulStep) {
            if (mode === 'manual') {
                markCalibrationSuccess(conversationId);
            } else {
                setCalibrationStatus('success');
                refreshButtonState(conversationId);
            }
            if (shouldPersistCalibrationProfile(mode)) {
                await rememberCalibrationSuccess(currentAdapter.name, successfulStep);
            }
            logger.info('Calibration capture succeeded', { conversationId, step: successfulStep, mode });
        } else {
            if (mode === 'manual') {
                setCalibrationStatus('error');
                refreshButtonState(conversationId);
            } else {
                setCalibrationStatus('idle');
            }
            logger.warn('Calibration capture failed after retries', { conversationId });
        }
    }

    // -----------------------------------------------------------------------
    // Conversation data retrieval and export
    // -----------------------------------------------------------------------

    async function getConversationData(options: { silent?: boolean; allowDegraded?: boolean } = {}) {
        if (!currentAdapter) {
            return null;
        }
        const conversationId = resolveConversationIdOrNotify(options.silent);
        if (!conversationId) {
            return null;
        }
        const data = resolveCapturedConversationOrNotify(conversationId, options.silent);
        if (!data) {
            return null;
        }
        if (!canExportConversationData(conversationId, options.allowDegraded === true, options.silent)) {
            return null;
        }
        applyTitleDomFallbackIfNeeded(conversationId, data);
        return data;
    }

    function resolveConversationIdOrNotify(silent?: boolean): string | null {
        const conversationId = resolveConversationIdForUserAction();
        if (conversationId) {
            return conversationId;
        }
        logger.error('No conversation ID found in URL');
        if (!silent) {
            alert('Please select a conversation first.');
        }
        return null;
    }

    function resolveCapturedConversationOrNotify(conversationId: string, silent?: boolean): ConversationData | null {
        const data = interceptionManager.getConversation(conversationId);
        if (data) {
            return data;
        }
        logger.warn('No data captured for this conversation yet.');
        if (!silent) {
            alert('Conversation data not yet captured. Please refresh the page or wait for the conversation to load.');
        }
        return null;
    }

    function canExportConversationData(conversationId: string, allowDegraded: boolean, silent?: boolean): boolean {
        const decision = resolveReadinessDecision(conversationId);
        const canExportNow =
            decision.mode === 'canonical_ready' || (allowDegraded && decision.mode === 'degraded_manual_only');
        if (canExportNow && !shouldBlockActionsForGeneration(conversationId)) {
            return true;
        }
        logger.warn('Conversation is still generating; export blocked until completion.', {
            conversationId,
            platform: currentAdapter?.name ?? 'Unknown',
            reason: decision.reason,
        });
        if (!silent) {
            alert(
                decision.mode === 'degraded_manual_only'
                    ? 'Canonical capture timed out. Use Force Save to export potentially incomplete data.'
                    : 'Response is still generating. Please wait for completion, then try again.',
            );
        }
        return false;
    }

    function applyTitleDomFallbackIfNeeded(conversationId: string, data: ConversationData) {
        if (!currentAdapter?.extractTitleFromDom || !currentAdapter.defaultTitles) {
            return;
        }
        const streamTitle = streamResolvedTitles.get(conversationId) ?? null;
        const domTitle = currentAdapter.extractTitleFromDom();
        const promptDerivedTitle = deriveConversationTitleFromFirstUserMessage(data);
        const titleDecision = resolveConversationTitleByPrecedence({
            streamTitle,
            cachedTitle: data.title ?? null,
            domTitle,
            firstUserMessageTitle: promptDerivedTitle,
            fallbackTitle: data.title ?? 'Conversation',
            platformDefaultTitles: currentAdapter.defaultTitles,
        });
        const currentTitle = (data.title ?? '').trim();
        logger.info('Title fallback check', {
            conversationId,
            adapter: currentAdapter.name,
            streamTitle,
            cachedTitle: currentTitle || null,
            domTitle: domTitle ?? null,
            resolvedSource: titleDecision.source,
            resolvedTitle: titleDecision.title,
        });
        if (titleDecision.title !== currentTitle) {
            logger.info('Title resolved from shared fallback policy', {
                conversationId,
                oldTitle: data.title,
                newTitle: titleDecision.title,
                source: titleDecision.source,
            });
            data.title = titleDecision.title;
        }
    }

    async function saveConversation(
        data: ConversationData,
        options: { allowDegraded?: boolean } = {},
    ): Promise<boolean> {
        if (!currentAdapter) {
            return false;
        }
        if (buttonManager.exists()) {
            buttonManager.setLoading(true, 'save');
        }
        try {
            const cachedTitle = data.title ?? null;
            const titleDecision = applyResolvedExportTitle(data);
            logger.info('Export title decision', {
                conversationId: data.conversation_id,
                adapter: currentAdapter.name,
                source: titleDecision.source,
                cachedTitle,
                resolvedTitle: titleDecision.title,
            });
            const filename = currentAdapter.formatFilename(data);
            const exportMeta = buildExportMetaForSave(data.conversation_id, options.allowDegraded);
            const exportPayload = await buildExportPayload(data, exportMeta);
            downloadAsJSON(exportPayload, filename);
            logger.info(`Saved conversation: ${filename}.json`);
            if (options.allowDegraded === true) {
                structuredLogger.emit(
                    peekAttemptId(data.conversation_id) ?? 'unknown',
                    'warn',
                    'force_save_degraded_export',
                    'Degraded manual export forced by user',
                    { conversationId: data.conversation_id },
                    `force-save-degraded:${data.conversation_id}`,
                );
            }
            if (buttonManager.exists()) {
                buttonManager.setSuccess('save');
            }
            return true;
        } catch (error) {
            logger.error('Failed to save conversation:', error);
            alert('Failed to save conversation. Check console for details.');
            if (buttonManager.exists()) {
                buttonManager.setLoading(false, 'save');
            }
            return false;
        }
    }

    const buildExportMetaForSave = (conversationId: string, allowDegraded?: boolean): ExportMeta => {
        if (allowDegraded === true) {
            return { captureSource: 'dom_snapshot_degraded', fidelity: 'degraded', completeness: 'partial' };
        }
        return getCaptureMeta(conversationId);
    };

    // -----------------------------------------------------------------------
    // Page snapshot bridge
    // -----------------------------------------------------------------------

    async function requestPageSnapshot(conversationId: string): Promise<unknown | null> {
        const requestId =
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
                ? crypto.randomUUID()
                : `snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`;

        return new Promise((resolve) => {
            const timeout = window.setTimeout(() => {
                window.removeEventListener('message', onMessage);
                resolve(null);
            }, 2500);

            const onMessage = (event: MessageEvent) => {
                if (event.source !== window || event.origin !== window.location.origin) {
                    return;
                }
                const msg = event.data as Record<string, unknown> | null;
                if (
                    msg?.type !== 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE' ||
                    msg.requestId !== requestId ||
                    resolveTokenValidationFailureReason(msg) !== null
                ) {
                    return;
                }
                clearTimeout(timeout);
                window.removeEventListener('message', onMessage);
                resolve(msg.success ? msg.data : null);
            };

            window.addEventListener('message', onMessage);
            window.postMessage(
                stampToken({ type: 'BLACKIYA_PAGE_SNAPSHOT_REQUEST', requestId, conversationId }),
                window.location.origin,
            );
        });
    }

    // -----------------------------------------------------------------------
    // Lifecycle state management
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Generation guard (delegates to generation-guard module)
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Button state
    // -----------------------------------------------------------------------

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
        const displayState = resolveDisplayedCalibrationState(conversationId);
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

        // Ensure SFE has a canonical sample for any network-sourced data.
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

        // Sync calibration display.
        if (isCanonicalReady && calibrationState !== 'capturing') {
            setCalibrationStatus('success');
            syncCalibrationButtonDisplay();
        } else if (!isCanonicalReady && calibrationState === 'success') {
            setCalibrationStatus('idle');
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

    // -----------------------------------------------------------------------
    // Auto-capture
    // -----------------------------------------------------------------------

    const shouldSkipAutoCapture = (conversationId: string): boolean =>
        !currentAdapter ||
        calibrationState !== 'idle' ||
        isConversationReadyForActions(conversationId, { includeDegraded: true });

    const scheduleDeferredAutoCapture = (
        attemptKey: string,
        conversationId: string,
        reason: 'response-finished' | 'navigation',
    ) => {
        if (autoCaptureRetryTimers.has(attemptKey)) {
            return;
        }
        if (!autoCaptureDeferredLogged.has(attemptKey)) {
            logger.info('Auto calibration deferred: response still generating', {
                platform: currentAdapter?.name ?? 'Unknown',
                conversationId,
                reason,
            });
            addBoundedSetValue(autoCaptureDeferredLogged, attemptKey, MAX_AUTOCAPTURE_KEYS);
        }
        const timerId = window.setTimeout(() => {
            autoCaptureRetryTimers.delete(attemptKey);
            maybeRunAutoCapture(conversationId, reason);
        }, 4000);
        autoCaptureRetryTimers.set(attemptKey, timerId);
    };

    const shouldThrottleAutoCapture = (attemptKey: string): boolean => {
        const now = Date.now();
        const lastAttempt = autoCaptureAttempts.get(attemptKey) ?? 0;
        if (now - lastAttempt < 12000) {
            return true;
        }
        setBoundedMapValue(autoCaptureAttempts, attemptKey, now, MAX_AUTOCAPTURE_KEYS);
        return false;
    };

    const runAutoCaptureFromPreference = (conversationId: string, reason: 'response-finished' | 'navigation') => {
        const run = () => {
            if (shouldSkipAutoCapture(conversationId) || !rememberedPreferredStep) {
                return;
            }
            logger.info('Auto calibration run from remembered strategy', {
                platform: currentAdapter?.name ?? 'Unknown',
                conversationId,
                preferredStep: rememberedPreferredStep,
                reason,
            });
            void runCalibrationCapture('auto', conversationId);
        };
        if (rememberedPreferredStep || calibrationPreferenceLoaded) {
            run();
            return;
        }
        if (!currentAdapter) {
            return;
        }
        void ensureCalibrationPreferenceLoaded(currentAdapter.name).then(run);
    };

    function maybeRunAutoCapture(conversationId: string, reason: 'response-finished' | 'navigation') {
        if (shouldSkipAutoCapture(conversationId)) {
            return;
        }
        const adapter = currentAdapter;
        if (!adapter) {
            return;
        }
        let attemptKey = peekAttemptId(conversationId);
        if (adapter.name === 'ChatGPT' && isPlatformGenerating(adapter)) {
            if (!attemptKey) {
                attemptKey = resolveAttemptId(conversationId);
            }
            scheduleDeferredAutoCapture(attemptKey, conversationId, reason);
            return;
        }
        if (attemptKey) {
            autoCaptureDeferredLogged.delete(attemptKey);
        }
        if (attemptKey && shouldThrottleAutoCapture(attemptKey)) {
            return;
        }
        runAutoCaptureFromPreference(conversationId, reason);
    }

    // -----------------------------------------------------------------------
    // Response finished signal handling
    // -----------------------------------------------------------------------

    const applyCompletedLifecycleState = (conversationId: string, attemptId: string) => {
        lifecycleAttemptId = attemptId;
        lifecycleConversationId = conversationId;
        setLifecycleState('completed', conversationId);
    };

    const shouldPromoteGrokFromCanonicalCapture = (
        source: 'network' | 'dom',
        cachedReady: boolean,
        lifecycle: LifecycleUiState,
    ): boolean => {
        if (source !== 'network' || currentAdapter?.name !== 'Grok' || !cachedReady) {
            return false;
        }
        return lifecycle === 'idle' || lifecycle === 'prompt-sent' || lifecycle === 'streaming';
    };

    const handleFinishedConversation = (conversationId: string, attemptId: string, source: 'network' | 'dom') => {
        const cached = interceptionManager.getConversation(conversationId);
        const cachedReady = !!cached && evaluateReadinessForData(cached).ready;

        if (shouldPromoteGrokFromCanonicalCapture(source, cachedReady, lifecycleState)) {
            applyCompletedLifecycleState(conversationId, attemptId);
        }

        const shouldPromoteGenericCompleted =
            lifecycleState !== 'completed' && source === 'dom' && currentAdapter?.name === 'ChatGPT';
        if (shouldPromoteGenericCompleted) {
            applyCompletedLifecycleState(conversationId, attemptId);
        }

        if (!cached || !cachedReady) {
            if (!shouldPromoteGenericCompleted) {
                applyCompletedLifecycleState(conversationId, attemptId);
            }
            void runStreamDoneProbe(conversationId, attemptId);
        }

        refreshButtonState(conversationId);
        scheduleButtonRefresh(conversationId);
        maybeRunAutoCapture(conversationId, 'response-finished');
    };

    const resolveFinishedSignalDebounce = (
        conversationId: string,
        source: 'network' | 'dom',
        attemptId: string | null,
    ): { minIntervalMs: number; effectiveAttemptId: string } => {
        const isSameConversation = conversationId === lastResponseFinishedConversationId;
        const effectiveAttemptId = attemptId ?? '';
        const isNewAttemptInSameConversation =
            source === 'network' &&
            isSameConversation &&
            !!lastResponseFinishedAttemptId &&
            lastResponseFinishedAttemptId !== effectiveAttemptId;
        return {
            minIntervalMs: source === 'network' ? (isNewAttemptInSameConversation ? 900 : 4500) : 1500,
            effectiveAttemptId,
        };
    };

    const shouldProcessFinishedSignal = (
        conversationId: string | null,
        source: 'network' | 'dom',
        attemptId: string | null,
    ): boolean => {
        if (!conversationId) {
            logger.info('Finished signal ignored: missing conversation context', { source });
            return false;
        }
        if (
            source === 'network' &&
            currentAdapter?.name === 'ChatGPT' &&
            shouldBlockActionsForGeneration(conversationId)
        ) {
            logger.info('Finished signal blocked by generation guard', { conversationId, source });
            return false;
        }
        const now = Date.now();
        const isSameConversation = conversationId === lastResponseFinishedConversationId;
        const { minIntervalMs, effectiveAttemptId } = resolveFinishedSignalDebounce(conversationId, source, attemptId);
        if (isSameConversation && now - lastResponseFinishedAt < minIntervalMs) {
            logger.info('Finished signal debounced', {
                conversationId,
                source,
                attemptId: effectiveAttemptId || null,
                elapsed: now - lastResponseFinishedAt,
                minIntervalMs,
            });
            return false;
        }
        lastResponseFinishedAt = now;
        lastResponseFinishedConversationId = conversationId;
        if (effectiveAttemptId) {
            lastResponseFinishedAttemptId = effectiveAttemptId;
        }
        return true;
    };

    function handleResponseFinished(source: 'network' | 'dom', hintedConversationId?: string) {
        const conversationId =
            hintedConversationId ??
            (currentAdapter ? currentAdapter.extractConversationId(window.location.href) : null) ??
            currentConversationId;
        const peekedAttemptId = conversationId ? peekAttemptId(conversationId) : null;
        if (!shouldProcessFinishedSignal(conversationId, source, peekedAttemptId)) {
            return;
        }
        const attemptId = peekedAttemptId ?? resolveAttemptId(conversationId ?? undefined);
        if (!peekedAttemptId) {
            lastResponseFinishedAttemptId = attemptId;
        }
        setActiveAttempt(attemptId);
        ingestSfeLifecycle('completed_hint', attemptId, conversationId);
        if (conversationId) {
            setCurrentConversation(conversationId);
            bindAttempt(conversationId, attemptId);
        }
        logger.info('Response finished signal', { source, attemptId, conversationId, calibrationState });
        if (calibrationState === 'waiting') {
            return;
        }
        if (conversationId) {
            handleFinishedConversation(conversationId, attemptId, source);
        }
    }

    // -----------------------------------------------------------------------
    // Wire message handlers
    // -----------------------------------------------------------------------

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
    ) => {
        if (phase === 'prompt-sent') {
            ingestSfeLifecycle('prompt_sent', attemptId, conversationId ?? null);
        } else if (phase === 'streaming') {
            ingestSfeLifecycle('streaming', attemptId, conversationId ?? null);
        } else if (phase === 'completed') {
            ingestSfeLifecycle('completed_hint', attemptId, conversationId ?? null);
        } else if (phase === 'terminated') {
            ingestSfeLifecycle('terminated_partial', attemptId, conversationId ?? null);
        }
    };

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
        // Replay pending lifecycle signal
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

    // -----------------------------------------------------------------------
    // Window bridge / completion watcher
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Navigation
    // -----------------------------------------------------------------------

    function handleNavigationChange() {
        if (!currentAdapter) {
            return;
        }
        const newConversationId = currentAdapter.extractConversationId(window.location.href);
        if (newConversationId !== currentConversationId) {
            handleConversationSwitch(newConversationId);
        } else {
            if (newConversationId && !buttonManager.exists()) {
                setTimeout(injectSaveButton, 500);
            } else {
                refreshButtonState(newConversationId || undefined);
            }
        }
    }

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

    function handleConversationSwitch(newId: string | null) {
        const isNewConversationNavigation = !currentConversationId && isLifecycleActiveGeneration() && !!newId;
        if (!isNewConversationNavigation) {
            disposeInFlightAttemptsOnNavigation(newId);
        }
        if (!newId) {
            setCurrentConversation(null);
            if (!isLifecycleActiveGeneration()) {
                setLifecycleState('idle');
            }
            setTimeout(injectSaveButton, 300);
            return;
        }
        if (!isNewConversationNavigation) {
            buttonManager.remove();
        }
        setCurrentConversation(newId);
        // Switch adapter if the platform changed.
        const newAdapter = getPlatformAdapter(window.location.href);
        if (newAdapter && currentAdapter && newAdapter.name !== currentAdapter.name) {
            currentAdapter = newAdapter;
            runnerState.adapter = newAdapter;
            interceptionManager.updateAdapter(currentAdapter);
            calibrationPreferenceLoaded = false;
            calibrationPreferenceLoading = null;
            void ensureCalibrationPreferenceLoaded(currentAdapter.name);
        }
        if (isNewConversationNavigation) {
            logger.info('Conversation switch -> preserving active lifecycle', {
                newId,
                preservedState: lifecycleState,
            });
            setLifecycleState(lifecycleState, newId);
        } else {
            setTimeout(injectSaveButton, 500);
            logger.info('Conversation switch -> idle', { newId, previousState: lifecycleState });
            setLifecycleState('idle', newId);
        }
        void warmFetchConversationSnapshot(newId, 'conversation-switch');
        setTimeout(() => {
            maybeRunAutoCapture(newId, 'navigation');
        }, 1800);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Boot sequence
    // -----------------------------------------------------------------------

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

    type StorageChangeMap = Parameters<Parameters<typeof browser.storage.onChanged.addListener>[0]>[0];

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

    // -----------------------------------------------------------------------
    // Cleanup / teardown
    // -----------------------------------------------------------------------

    let cleanedUp = false;
    let beforeUnloadHandler: (() => void) | null = null;

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
