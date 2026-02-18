/**
 * Platform Runner Utility
 *
 * Orchestrator that ties together the specialized managers for:
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
import { loadCalibrationProfileV2IfPresent, saveCalibrationProfileV2 } from '@/utils/calibration-profile';
import { buildCommonExport } from '@/utils/common-export';
import { isConversationReady } from '@/utils/conversation-readiness';
import { streamDumpStorage } from '@/utils/diagnostics-stream-dump';
import { downloadAsJSON } from '@/utils/download';
import { hashText } from '@/utils/hash';
import { logger } from '@/utils/logger';
import { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import { InterceptionManager } from '@/utils/managers/interception-manager';
import { NavigationManager } from '@/utils/managers/navigation-manager';
import type {
    AttemptDisposedMessage,
    ConversationIdResolvedMessage,
    ResponseFinishedMessage,
    ResponseLifecycleMessage,
    StreamDeltaMessage,
    StreamDumpConfigMessage,
    StreamDumpFrameMessage,
    TitleResolvedMessage,
} from '@/utils/protocol/messages';
import { generateSessionToken, isValidToken, setSessionToken, stampToken } from '@/utils/protocol/session-token';
import {
    getConversationAttemptMismatch as getConversationAttemptMismatchForRegistry,
    resolveRunnerAttemptId,
    shouldRemoveDisposedAttemptBinding as shouldRemoveDisposedAttemptBindingFromRegistry,
} from '@/utils/runner/attempt-registry';
import { type CalibrationStep, prioritizeCalibrationStep } from '@/utils/runner/calibration-runner';
import { buildRunnerSnapshotConversationData } from '@/utils/runner/dom-snapshot';
import { applyResolvedExportTitle } from '@/utils/runner/export-pipeline';
import { getLifecyclePhasePriority } from '@/utils/runner/lifecycle-manager';
import { dispatchRunnerMessage } from '@/utils/runner/message-bridge';
import { resolveRunnerReadinessDecision } from '@/utils/runner/readiness';
import { RunnerState } from '@/utils/runner/state';
import { appendStreamProbePreview } from '@/utils/runner/stream-probe';
import { DEFAULT_EXPORT_FORMAT, type ExportFormat, STORAGE_KEYS } from '@/utils/settings';
import { shouldIngestAsCanonicalSample, shouldUseCachedConversationForWarmFetch } from '@/utils/sfe/capture-fidelity';
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

interface SnapshotMessageCandidate {
    role: 'user' | 'assistant';
    text: string;
}

type CalibrationMode = 'manual' | 'auto';
type LifecycleUiState = 'idle' | 'prompt-sent' | 'streaming' | 'completed';
type CalibrationUiState = 'idle' | 'waiting' | 'capturing' | 'success' | 'error';
type InterceptionCaptureMeta = { attemptId?: string; source?: string };
const CANONICAL_STABILIZATION_RETRY_DELAY_MS = 1150;
const CANONICAL_STABILIZATION_MAX_RETRIES = 6;
const CANONICAL_STABILIZATION_TIMEOUT_GRACE_MS = 400;
const SFE_STABILIZATION_MAX_WAIT_MS = 3200;
const PROBE_LEASE_TTL_MS = 5000;
const PROBE_LEASE_RETRY_GRACE_MS = 500;
const MAX_CONVERSATION_ATTEMPTS = 250;
const MAX_STREAM_PREVIEWS = 150;
const MAX_AUTOCAPTURE_KEYS = 400;
const CANONICAL_READY_LOG_TTL_MS = 15_000;
const RUNNER_CONTROL_KEY = '__BLACKIYA_RUNNER_CONTROL__';

type RunnerControl = {
    cleanup?: () => void;
};

export function buildCalibrationOrderForMode(
    preferredStep: CalibrationStep | null,
    mode: CalibrationMode,
    platformName?: string,
): CalibrationStep[] {
    const defaultOrder: CalibrationStep[] = ['queue-flush', 'passive-wait', 'endpoint-retry', 'page-snapshot'];
    if (!preferredStep) {
        return defaultOrder;
    }

    if (mode === 'auto' && preferredStep === 'page-snapshot') {
        // For ChatGPT, snapshot fallback is currently the most reliable and avoids long endpoint-retry delays.
        if (platformName === 'ChatGPT') {
            return ['queue-flush', 'page-snapshot', 'passive-wait', 'endpoint-retry'];
        }
        return defaultOrder;
    }

    const reordered = prioritizeCalibrationStep(preferredStep, defaultOrder);
    if (mode !== 'auto') {
        return reordered;
    }

    // In auto mode, keep page-snapshot as a last resort to reduce premature partial captures.
    const withoutSnapshot = reordered.filter((step) => step !== 'page-snapshot');
    return [...withoutSnapshot, 'page-snapshot'];
}

export function shouldPersistCalibrationProfile(mode: CalibrationMode): boolean {
    return mode === 'manual';
}

function preferredStepFromStrategy(strategy: 'aggressive' | 'balanced' | 'conservative'): CalibrationStep {
    if (strategy === 'aggressive') {
        return 'passive-wait';
    }
    if (strategy === 'balanced') {
        return 'endpoint-retry';
    }
    return 'queue-flush';
}

function strategyFromPreferredStep(step: CalibrationStep): 'aggressive' | 'balanced' | 'conservative' {
    if (step === 'passive-wait') {
        return 'aggressive';
    }
    if (step === 'endpoint-retry') {
        return 'balanced';
    }
    return 'conservative';
}

function normalizeContentText(text: string): string {
    return text.trim().normalize('NFC');
}

export function resolveExportConversationTitle(data: ConversationData): string {
    return resolveExportTitleDecision(data).title;
}

export function shouldRemoveDisposedAttemptBinding(
    mappedAttemptId: string,
    disposedAttemptId: string,
    resolveAttemptId: (attemptId: string) => string,
): boolean {
    return shouldRemoveDisposedAttemptBindingFromRegistry(mappedAttemptId, disposedAttemptId, resolveAttemptId);
}

export type CanonicalStabilizationAttemptState = {
    timerIds: Map<string, number>;
    retryCounts: Map<string, number>;
    startedAt: Map<string, number>;
    timeoutWarnings: Set<string>;
    inProgress: Set<string>;
};

export function beginCanonicalStabilizationTick(attemptId: string, inProgress: Set<string>): boolean {
    if (inProgress.has(attemptId)) {
        return false;
    }
    inProgress.add(attemptId);
    return true;
}

export function clearCanonicalStabilizationAttemptState(
    attemptId: string,
    state: CanonicalStabilizationAttemptState,
    clearTimer: (timerId: number) => void = (timerId) => {
        clearTimeout(timerId);
    },
): void {
    const timerId = state.timerIds.get(attemptId);
    if (timerId !== undefined) {
        clearTimer(timerId);
    }
    state.timerIds.delete(attemptId);
    state.retryCounts.delete(attemptId);
    state.startedAt.delete(attemptId);
    state.timeoutWarnings.delete(attemptId);
    state.inProgress.delete(attemptId);
}

export function resolveShouldSkipCanonicalRetryAfterAwait(
    attemptId: string,
    _conversationId: string,
    disposedOrSuperseded: boolean,
    mappedAttemptId: string | undefined,
    resolveAttemptId: (attemptId: string) => string,
): boolean {
    if (disposedOrSuperseded) {
        return true;
    }
    if (!mappedAttemptId) {
        return false;
    }
    return resolveAttemptId(mappedAttemptId) !== resolveAttemptId(attemptId);
}

export function runPlatform(): void {
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

    // S-01: Generate per-session token for postMessage authentication
    const sessionToken = generateSessionToken();
    setSessionToken(sessionToken);

    // Share session token with MAIN world (interceptor) via handshake
    window.postMessage({ type: 'BLACKIYA_SESSION_INIT', token: sessionToken }, window.location.origin);

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
    const preservedLiveStreamSnapshotByConversation = new Map<string, string>();
    let streamDumpEnabled = false;
    const streamProbeControllers = new Map<string, AbortController>();
    const probeLeaseRetryTimers = new Map<string, number>();
    const canonicalStabilizationRetryTimers = new Map<string, number>();
    const canonicalStabilizationRetryCounts = new Map<string, number>();
    const canonicalStabilizationStartedAt = new Map<string, number>();
    const timeoutWarningByAttempt = new Set<string>();
    const canonicalStabilizationInProgress = new Set<string>();
    let lastResponseFinishedAt = 0;
    let lastResponseFinishedConversationId: string | null = null;
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
        readinessGate: new ReadinessGate({
            maxStabilizationWaitMs: SFE_STABILIZATION_MAX_WAIT_MS,
        }),
    });
    const structuredLogger = new StructuredAttemptLogger();
    const attemptByConversation = runnerState.attemptByConversation;
    const attemptAliasForward = runnerState.attemptAliasForward;
    const pendingLifecycleByAttempt = new Map<
        string,
        {
            phase: ResponseLifecycleMessage['phase'];
            platform: string;
            receivedAtMs: number;
        }
    >();
    const captureMetaByConversation = runnerState.captureMetaByConversation;
    const probeLease = new CrossTabProbeLease();
    const streamResolvedTitles = new Map<string, string>();
    const lastCanonicalReadyLogAtByConversation = new Map<string, number>();
    let activeAttemptId: string | null = null;

    function setCurrentConversation(conversationId: string | null): void {
        currentConversationId = conversationId;
        runnerState.conversationId = conversationId;
    }

    function setActiveAttempt(attemptId: string | null): void {
        activeAttemptId = attemptId;
        runnerState.activeAttemptId = attemptId;
    }

    function cachePendingLifecycleSignal(
        attemptId: string,
        phase: ResponseLifecycleMessage['phase'],
        platform: string,
    ): void {
        const existing = pendingLifecycleByAttempt.get(attemptId);
        if (existing && getLifecyclePhasePriority(existing.phase) > getLifecyclePhasePriority(phase)) {
            return;
        }
        setBoundedMapValue(
            pendingLifecycleByAttempt,
            attemptId,
            {
                phase,
                platform,
                receivedAtMs: Date.now(),
            },
            MAX_CONVERSATION_ATTEMPTS * 2,
        );
    }

    function setCaptureMetaForConversation(conversationId: string, meta: ExportMeta): void {
        setBoundedMapValue(captureMetaByConversation, conversationId, meta, MAX_CONVERSATION_ATTEMPTS);
    }

    function markSnapshotCaptureMeta(conversationId: string): void {
        setCaptureMetaForConversation(conversationId, {
            captureSource: 'dom_snapshot_degraded',
            fidelity: 'degraded',
            completeness: 'partial',
        });
    }

    function markCanonicalCaptureMeta(conversationId: string): void {
        setCaptureMetaForConversation(conversationId, {
            captureSource: 'canonical_api',
            fidelity: 'high',
            completeness: 'complete',
        });
    }

    function resolveAliasedAttemptId(attemptId: string): string {
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
    }

    function forwardAttemptAlias(fromAttemptId: string, toAttemptId: string, reason: 'superseded' | 'rebound'): void {
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
    }

    // -- Manager Initialization --

    // 1. UI Manager
    const buttonManager = new ButtonManager(handleSaveClick, handleCopyClick, handleCalibrationClick);

    function applyStreamResolvedTitleIfNeeded(conversationId: string, data: ConversationData): void {
        const streamTitle = streamResolvedTitles.get(conversationId);
        if (streamTitle && data.title !== streamTitle) {
            data.title = streamTitle;
        }
    }

    function updateActiveAttemptFromMeta(conversationId: string, meta?: InterceptionCaptureMeta): void {
        if (!meta?.attemptId) {
            return;
        }
        setActiveAttempt(meta.attemptId);
        bindAttempt(conversationId, meta.attemptId);
    }

    function handleSnapshotSourceCapture(conversationId: string, source: string): void {
        const existingDecision = resolveReadinessDecision(conversationId);
        if (existingDecision.mode === 'canonical_ready') {
            markCanonicalCaptureMeta(conversationId);
        } else {
            markSnapshotCaptureMeta(conversationId);
        }
        structuredLogger.emit(
            resolveAttemptId(conversationId),
            'info',
            'snapshot_degraded_mode_used',
            'Snapshot-based capture marked as degraded/manual-only',
            { conversationId, source },
            `snapshot-degraded:${conversationId}:${source}`,
        );

        const retryAttemptIdResolved = resolveAttemptId(conversationId);
        logger.info('Snapshot retry decision', {
            conversationId,
            lifecycleState,
            willSchedule: lifecycleState === 'completed',
            attemptId: retryAttemptIdResolved,
        });
        if (lifecycleState === 'completed') {
            scheduleCanonicalStabilizationRetry(conversationId, retryAttemptIdResolved);
        }
    }

    function handleNetworkSourceCapture(
        conversationId: string,
        meta?: InterceptionCaptureMeta,
        data?: ConversationData,
    ): void {
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
    }

    function processInterceptionCapture(
        capturedId: string,
        data: ConversationData,
        meta?: InterceptionCaptureMeta,
    ): void {
        applyStreamResolvedTitleIfNeeded(capturedId, data);
        setCurrentConversation(capturedId);
        updateActiveAttemptFromMeta(capturedId, meta);

        const source = meta?.source ?? 'network';
        const isSnapshotSource = source.includes('snapshot') || source.includes('dom');
        if (isSnapshotSource) {
            handleSnapshotSourceCapture(capturedId, source);
        } else {
            handleNetworkSourceCapture(capturedId, meta, data);
        }

        refreshButtonState(capturedId);
        if (evaluateReadinessForData(data).ready) {
            handleResponseFinished('network', capturedId);
        }
    }

    // 2. Data Manager
    const interceptionManager = new InterceptionManager((capturedId, data, meta) => {
        processInterceptionCapture(capturedId, data, meta);
    });

    // 3. Navigation Manager
    const navigationManager = new NavigationManager(() => {
        handleNavigationChange();
    });

    /**
     * Core orchestrator logic functions
     */
    async function getExportFormat(): Promise<ExportFormat> {
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

    function bindAttempt(conversationId: string | undefined, attemptId: string): void {
        if (!conversationId) {
            return;
        }
        const isNewBinding = !attemptByConversation.has(conversationId);
        const previous = attemptByConversation.get(conversationId);
        if (previous && previous !== attemptId) {
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
        setBoundedMapValue(attemptByConversation, conversationId, attemptId, MAX_CONVERSATION_ATTEMPTS);
        if (isNewBinding || previous !== attemptId) {
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

    function isAttemptDisposedOrSuperseded(attemptId: string): boolean {
        const phase = sfe.resolve(attemptId).phase;
        return phase === 'disposed' || phase === 'superseded';
    }

    function emitAliasResolutionLog(
        canonicalAttemptId: string,
        signalType: 'lifecycle' | 'finished' | 'delta' | 'conversation-resolved',
        originalAttemptId: string,
        conversationId?: string,
    ): void {
        structuredLogger.emit(
            canonicalAttemptId,
            'debug',
            'attempt_alias_forwarded',
            'Resolved stale attempt alias before processing signal',
            {
                signalType,
                originalAttemptId,
                canonicalAttemptId,
                conversationId: conversationId ?? null,
            },
            `attempt-alias-resolve:${signalType}:${originalAttemptId}:${canonicalAttemptId}`,
        );
    }

    function emitLateSignalDrop(
        canonicalAttemptId: string,
        signalType: 'lifecycle' | 'finished' | 'delta' | 'conversation-resolved',
        conversationId?: string,
    ): void {
        structuredLogger.emit(
            canonicalAttemptId,
            'debug',
            'late_signal_dropped_after_dispose',
            'Dropped late signal for disposed or superseded attempt',
            { signalType, reason: 'disposed_or_superseded', conversationId: conversationId ?? null },
            `stale:${signalType}:${conversationId ?? 'unknown'}:disposed`,
        );
    }

    function getConversationAttemptMismatch(canonicalAttemptId: string, conversationId?: string): string | null {
        return getConversationAttemptMismatchForRegistry(
            canonicalAttemptId,
            conversationId,
            attemptByConversation,
            resolveAliasedAttemptId,
        );
    }

    function emitConversationMismatchDrop(
        canonicalAttemptId: string,
        signalType: 'lifecycle' | 'finished' | 'delta' | 'conversation-resolved',
        conversationId: string,
        activeAttemptId: string,
    ): void {
        structuredLogger.emit(
            canonicalAttemptId,
            'debug',
            'stale_signal_ignored',
            'Ignored stale attempt signal',
            { signalType, reason: 'conversation_mismatch', conversationId, activeAttemptId },
            `stale:${signalType}:${conversationId}:${activeAttemptId}`,
        );
    }

    function isStaleAttemptMessage(
        attemptId: string,
        conversationId: string | undefined,
        signalType: 'lifecycle' | 'finished' | 'delta' | 'conversation-resolved',
    ): boolean {
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
    }

    function cancelStreamDoneProbe(
        attemptId: string,
        reason: 'superseded' | 'disposed' | 'navigation' | 'teardown',
    ): void {
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

    function clearProbeLeaseRetry(attemptId: string): void {
        const timerId = probeLeaseRetryTimers.get(attemptId);
        if (timerId !== undefined) {
            clearTimeout(timerId);
            probeLeaseRetryTimers.delete(attemptId);
        }
    }

    async function tryAcquireProbeLease(conversationId: string, attemptId: string): Promise<boolean> {
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
            {
                conversationId,
                ownerAttemptId: claim.ownerAttemptId,
                expiresAtMs: claim.expiresAtMs,
            },
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
    }

    function clearCanonicalStabilizationRetry(attemptId: string): void {
        const hadTimer = canonicalStabilizationRetryTimers.has(attemptId);
        if (hadTimer) {
            logger.info('Stabilization retry cleared', { attemptId });
        }
        clearCanonicalStabilizationAttemptState(
            attemptId,
            {
                timerIds: canonicalStabilizationRetryTimers,
                retryCounts: canonicalStabilizationRetryCounts,
                startedAt: canonicalStabilizationStartedAt,
                timeoutWarnings: timeoutWarningByAttempt,
                inProgress: canonicalStabilizationInProgress,
            },
            (timerId) => {
                clearTimeout(timerId);
            },
        );
    }

    function emitTimeoutWarningOnce(attemptId: string, conversationId: string): void {
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
    }

    function maybeRestartCanonicalRecoveryAfterTimeout(conversationId: string, attemptId: string): void {
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
            logger.info('Timeout: elapsed exceeded max wait', {
                attemptId,
                retries,
                elapsed,
                timeoutMs,
            });
        }
        return elapsed >= timeoutMs;
    }

    async function tryPromoteReadySnapshotAsCanonical(
        conversationId: string,
        attemptId: string,
        retries: number,
        fetchSucceeded: boolean,
        readinessResult: PlatformReadiness,
    ): Promise<boolean> {
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
    }

    async function tryRefreshDegradedSnapshotAndPromote(
        conversationId: string,
        attemptId: string,
        retries: number,
        fetchSucceeded: boolean,
        readinessResult: PlatformReadiness,
    ): Promise<boolean> {
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

        logger.info('Fresh snapshot promoted to canonical after re-request', {
            conversationId,
            retries: retries + 1,
        });
        markCanonicalCaptureMeta(conversationId);
        ingestSfeCanonicalSample(recheckCached, attemptId);
        scheduleCanonicalStabilizationRetry(conversationId, attemptId);
        refreshButtonState(conversationId);
        return true;
    }

    function getReadyCachedConversation(conversationId: string): ConversationData | null {
        const recheckCached = interceptionManager.getConversation(conversationId);
        if (!recheckCached) {
            return null;
        }
        return evaluateReadinessForData(recheckCached).ready ? recheckCached : null;
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
    ): void {
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

    async function handleDegradedCanonicalCandidate(
        conversationId: string,
        attemptId: string,
        retries: number,
        fetchSucceeded: boolean,
        cached: ConversationData,
    ): Promise<void> {
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
    }

    function shouldSkipCanonicalRetryTick(conversationId: string, attemptId: string, retries: number): boolean {
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
    }

    function shouldSkipCanonicalRetryAfterAwait(conversationId: string, attemptId: string): boolean {
        const mappedAttempt = attemptByConversation.get(conversationId);
        const disposedOrSuperseded = isAttemptDisposedOrSuperseded(attemptId);
        const shouldSkip = resolveShouldSkipCanonicalRetryAfterAwait(
            attemptId,
            conversationId,
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
    }

    async function processCanonicalStabilizationRetryTick(
        conversationId: string,
        attemptId: string,
        retries: number,
    ): Promise<void> {
        if (!beginCanonicalStabilizationTick(attemptId, canonicalStabilizationInProgress)) {
            logger.info('Stabilization retry tick skipped: already in progress', {
                conversationId,
                attemptId,
            });
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
    }

    function scheduleCanonicalStabilizationRetry(conversationId: string, attemptId: string): void {
        if (canonicalStabilizationRetryTimers.has(attemptId)) {
            // #region agent log
            logger.info('Stabilization retry already scheduled (skip)', { conversationId, attemptId });
            // #endregion
            return;
        }
        if (isAttemptDisposedOrSuperseded(attemptId)) {
            // #region agent log
            logger.info('Stabilization retry skip: attempt disposed/superseded', { conversationId, attemptId });
            // #endregion
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
        // #region agent log
        logger.info('Stabilization retry scheduled', {
            conversationId,
            attemptId,
            retryNumber: retries + 1,
            delayMs: CANONICAL_STABILIZATION_RETRY_DELAY_MS,
        });
        // #endregion
    }

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
            .filter((message): message is NonNullable<(typeof data.mapping)[string]['message']> => !!message)
            .filter((message) => message.author.role === 'assistant');

        const latestAssistant = assistantMessages[assistantMessages.length - 1];
        const text = normalizeContentText((latestAssistant?.content.parts ?? []).join(''));
        const hasInProgress = assistantMessages.some((message) => message.status === 'in_progress');
        const terminal = !hasInProgress;

        return {
            ready: isConversationReady(data),
            terminal,
            reason: terminal ? 'terminal-snapshot' : 'assistant-in-progress',
            contentHash: text.length > 0 ? hashText(text) : null,
            latestAssistantTextLength: text.length,
        };
    }

    function ingestSfeLifecycle(phase: LifecyclePhase, attemptId: string, conversationId?: string | null): void {
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
    }

    function emitCanonicalSampleProcessed(
        attemptId: string,
        conversationId: string,
        resolution: ReturnType<SignalFusionEngine['applyCanonicalSample']>,
        readiness: PlatformReadiness,
    ): void {
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
    }

    function shouldScheduleCanonicalRetry(
        resolution: ReturnType<SignalFusionEngine['applyCanonicalSample']>,
        activeLifecycleState: LifecycleUiState,
    ): boolean {
        const hitStabilizationTimeout = resolution.blockingConditions.includes('stabilization_timeout');
        return (
            !resolution.ready &&
            !hitStabilizationTimeout &&
            activeLifecycleState === 'completed' &&
            (resolution.reason === 'awaiting_stabilization' || resolution.reason === 'captured_not_ready')
        );
    }

    function emitAwaitingCanonicalLog(
        attemptId: string,
        conversationId: string,
        resolution: ReturnType<SignalFusionEngine['applyCanonicalSample']>,
        contentHash: string | null,
    ): void {
        const isStabilizationWait = resolution.reason === 'awaiting_stabilization';
        structuredLogger.emit(
            attemptId,
            'info',
            isStabilizationWait ? 'awaiting_stabilization' : 'awaiting_canonical_capture',
            isStabilizationWait
                ? 'Awaiting canonical stabilization before ready'
                : 'Completed stream but canonical sample not terminal yet; scheduling retries',
            { conversationId, phase: resolution.phase },
            `${isStabilizationWait ? 'awaiting-stabilization' : 'awaiting-canonical'}:${conversationId}:${contentHash ?? 'none'}`,
        );
    }

    function emitCapturedReadyLog(
        attemptId: string,
        conversationId: string,
        resolution: ReturnType<SignalFusionEngine['applyCanonicalSample']>,
    ): void {
        structuredLogger.emit(
            attemptId,
            'info',
            'captured_ready',
            'Capture reached ready state',
            { conversationId, phase: resolution.phase },
            `captured-ready:${conversationId}`,
        );
    }

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
            emitAwaitingCanonicalLog(effectiveAttemptId, conversationId, resolution, readiness.contentHash ?? null);
        }
        if (resolution.blockingConditions.includes('stabilization_timeout')) {
            clearCanonicalStabilizationRetry(effectiveAttemptId);
        }
        if (resolution.ready) {
            clearCanonicalStabilizationRetry(effectiveAttemptId);
            syncStreamProbePanelFromCanonical(conversationId, data);
            emitCapturedReadyLog(effectiveAttemptId, conversationId, resolution);
        }
        return resolution;
    }

    function resolveSfeReady(conversationId: string): boolean {
        const resolution = sfe.resolveByConversation(conversationId);
        return !!resolution?.ready;
    }

    function logSfeMismatchIfNeeded(conversationId: string, legacyReady: boolean): void {
        if (!sfeEnabled) {
            return;
        }
        const attemptId = resolveAttemptId(conversationId);
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
    }

    function emitAttemptDisposed(attemptId: string, reason: AttemptDisposedMessage['reason']): void {
        pendingLifecycleByAttempt.delete(attemptId);
        structuredLogger.emit(
            attemptId,
            'info',
            'attempt_disposed',
            'Attempt disposed',
            { reason },
            `attempt-disposed:${reason}`,
        );
        const payload: AttemptDisposedMessage = {
            type: 'BLACKIYA_ATTEMPT_DISPOSED',
            attemptId,
            reason,
        };
        window.postMessage(stampToken(payload), window.location.origin);
    }

    function emitStreamDumpConfig(): void {
        const payload: StreamDumpConfigMessage = {
            type: 'BLACKIYA_STREAM_DUMP_CONFIG',
            enabled: streamDumpEnabled,
        };
        window.postMessage(stampToken(payload), window.location.origin);
    }

    async function loadStreamDumpSetting(): Promise<void> {
        try {
            const result = await browser.storage.local.get(STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_ENABLED);
            streamDumpEnabled = result[STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_ENABLED] === true;
        } catch (error) {
            logger.warn('Failed to load stream dump diagnostics setting', error);
            streamDumpEnabled = false;
        }
        emitStreamDumpConfig();
    }

    async function loadSfeSettings(): Promise<void> {
        try {
            const result = await browser.storage.local.get([STORAGE_KEYS.SFE_ENABLED]);
            sfeEnabled = result[STORAGE_KEYS.SFE_ENABLED] !== false;
            logger.info('SFE settings loaded', {
                sfeEnabled,
                probeLeaseArbitration: 'always_on',
            });
        } catch (error) {
            logger.warn('Failed to load SFE settings. Falling back to defaults.', error);
            sfeEnabled = true;
        }
    }

    async function loadCalibrationPreference(platformName: string): Promise<void> {
        try {
            const profileV2 = await loadCalibrationProfileV2IfPresent(platformName);
            if (profileV2) {
                rememberedPreferredStep = preferredStepFromStrategy(profileV2.strategy);
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
    }

    function ensureCalibrationPreferenceLoaded(platformName: string): Promise<void> {
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
    }

    function buildCalibrationTimings(step: CalibrationStep): CalibrationProfileV2['timingsMs'] {
        if (step === 'passive-wait') {
            return { passiveWait: 900, domQuietWindow: 500, maxStabilizationWait: 12_000 };
        }
        if (step === 'endpoint-retry') {
            return { passiveWait: 1400, domQuietWindow: 800, maxStabilizationWait: 18_000 };
        }
        return { passiveWait: 2200, domQuietWindow: 800, maxStabilizationWait: 30_000 };
    }

    function buildCalibrationRetry(step: CalibrationStep): CalibrationProfileV2['retry'] {
        if (step === 'passive-wait') {
            return { maxAttempts: 3, backoffMs: [300, 800, 1300], hardTimeoutMs: 12_000 };
        }
        if (step === 'endpoint-retry') {
            return { maxAttempts: 4, backoffMs: [400, 900, 1600, 2400], hardTimeoutMs: 20_000 };
        }
        return {
            maxAttempts: 6,
            backoffMs: [800, 1600, 2600, 3800, 5200, 7000],
            hardTimeoutMs: 30_000,
        };
    }

    function buildCalibrationProfile(platformName: string, step: CalibrationStep): CalibrationProfileV2 {
        return {
            schemaVersion: 2,
            platform: platformName,
            strategy: strategyFromPreferredStep(step),
            disabledSources: ['dom_hint', 'snapshot_fallback'],
            timingsMs: buildCalibrationTimings(step),
            retry: buildCalibrationRetry(step),
            updatedAt: new Date().toISOString(),
            lastModifiedBy: 'manual',
        };
    }

    async function rememberCalibrationSuccess(platformName: string, step: CalibrationStep): Promise<void> {
        try {
            rememberedPreferredStep = step;
            rememberedCalibrationUpdatedAt = new Date().toISOString();
            calibrationPreferenceLoaded = true;
            await saveCalibrationProfileV2(buildCalibrationProfile(platformName, step));
        } catch (error) {
            logger.warn('Failed to save calibration profile', error);
        }
    }

    function resolveDisplayedCalibrationState(_conversationId: string | null): CalibrationUiState {
        if (calibrationState === 'idle' && !!rememberedPreferredStep) {
            return 'success';
        }
        return calibrationState;
    }

    function syncCalibrationButtonDisplay(): void {
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
        const minuteMs = 60 * 1000;
        const hourMs = 60 * minuteMs;
        const dayMs = 24 * hourMs;

        if (ageMs < minuteMs) {
            return 'just now';
        }

        if (ageMs < hourMs) {
            const mins = Math.floor(ageMs / minuteMs);
            return `${mins}m ago`;
        }

        if (ageMs < dayMs) {
            const hours = Math.floor(ageMs / hourMs);
            return `${hours}h ago`;
        }

        return parsed.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
        });
    }

    function logLifecycleTransition(
        previousState: LifecycleUiState,
        nextState: LifecycleUiState,
        conversationId: string | null,
    ): void {
        // #region agent log — lifecycle transition tracking
        if (previousState !== nextState) {
            logger.info('Lifecycle transition', {
                from: previousState,
                to: nextState,
                conversationId,
            });
        }
        // #endregion
    }

    function syncLifecycleContext(state: LifecycleUiState, conversationId: string | null): void {
        if (state === 'idle') {
            lifecycleConversationId = null;
            lifecycleAttemptId = null;
            return;
        }
        if (conversationId) {
            lifecycleConversationId = conversationId;
        }
    }

    function applyLifecycleUiState(state: LifecycleUiState, conversationId?: string): void {
        if (!buttonManager.exists()) {
            return;
        }

        if (state === 'completed') {
            const targetConversationId = conversationId || extractConversationIdFromLocation() || undefined;
            if (targetConversationId) {
                refreshButtonState(targetConversationId);
                scheduleButtonRefresh(targetConversationId);
            }
            return;
        }

        if (state === 'prompt-sent' || state === 'streaming') {
            buttonManager.setActionButtonsEnabled(false);
            buttonManager.setOpacity('0.6');
        }
    }

    function setLifecycleState(state: LifecycleUiState, conversationId?: string): void {
        const resolvedConversationId = conversationId ?? currentConversationId ?? null;
        logLifecycleTransition(lifecycleState, state, resolvedConversationId);
        lifecycleState = state;
        runnerState.lifecycleState = state;
        syncLifecycleContext(state, resolvedConversationId);
        buttonManager.setLifecycleState(state);
        applyLifecycleUiState(state, conversationId);
    }

    function ensureStreamProbePanel(): HTMLDivElement {
        const existing = document.getElementById('blackiya-stream-probe') as HTMLDivElement | null;
        if (existing) {
            return existing;
        }

        const panel = document.createElement('div');
        panel.id = 'blackiya-stream-probe';
        panel.style.cssText = `
            position: fixed;
            left: 16px;
            bottom: 16px;
            width: min(560px, calc(100vw - 32px));
            max-height: 42vh;
            overflow: auto;
            z-index: 2147483647;
            background: rgba(15, 23, 42, 0.92);
            color: #e2e8f0;
            border: 1px solid rgba(148, 163, 184, 0.45);
            border-radius: 10px;
            box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
            font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            padding: 10px;
            white-space: pre-wrap;
            word-break: break-word;
        `;
        document.body.appendChild(panel);
        return panel;
    }

    function setStreamProbePanel(status: string, body: string): void {
        if (cleanedUp) {
            return;
        }
        const panel = ensureStreamProbePanel();
        const now = new Date().toLocaleTimeString();
        panel.textContent = `[Blackiya Stream Probe] ${status} @ ${now}\n\n${body}`;
    }

    function withPreservedLiveMirrorSnapshot(conversationId: string, status: string, primaryBody: string): string {
        if (!status.startsWith('stream-done:')) {
            return primaryBody;
        }

        const liveSnapshot = liveStreamPreviewByConversation.get(conversationId) ?? '';
        if (liveSnapshot.length === 0) {
            return primaryBody;
        }

        setBoundedMapValue(
            preservedLiveStreamSnapshotByConversation,
            conversationId,
            liveSnapshot,
            MAX_STREAM_PREVIEWS,
        );
        const normalizedPrimary = primaryBody.trim();
        const normalizedLive = liveSnapshot.trim();
        if (normalizedPrimary.length > 0 && normalizedPrimary === normalizedLive) {
            return primaryBody;
        }

        const boundedSnapshot = normalizedLive.length > 4000 ? `...${normalizedLive.slice(-3800)}` : normalizedLive;
        return `${primaryBody}\n\n--- Preserved live mirror snapshot (pre-final) ---\n${boundedSnapshot}`;
    }

    function syncStreamProbePanelFromCanonical(conversationId: string, data: ConversationData): void {
        const panel = document.getElementById('blackiya-stream-probe');
        if (!panel) {
            return;
        }
        if (lastStreamProbeConversationId !== conversationId) {
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

    function appendLiveStreamProbeText(conversationId: string, text: string): void {
        const current = liveStreamPreviewByConversation.get(conversationId) ?? '';
        let next = '';
        if (text.startsWith(current)) {
            next = text; // Snapshot-style update (preferred)
        } else if (current.startsWith(text)) {
            next = current; // Stale/shorter snapshot, ignore
        } else {
            // Delta-style fallback with conservative boundary guard.
            // Only inject a space when next chunk begins with uppercase (word boundary signal),
            // to avoid corrupting lowercase continuations like "Glass" + "es" or "W" + "earing".
            const needsSpaceJoin =
                current.length > 0 &&
                text.length > 0 &&
                !current.endsWith(' ') &&
                !current.endsWith('\n') &&
                !text.startsWith(' ') &&
                !text.startsWith('\n') &&
                /[A-Za-z0-9]$/.test(current) &&
                /^[A-Z]/.test(text);
            next = needsSpaceJoin ? `${current} ${text}` : `${current}${text}`;
        }
        const capped = appendStreamProbePreview('', next, 15_503);
        setBoundedMapValue(liveStreamPreviewByConversation, conversationId, capped, MAX_STREAM_PREVIEWS);
        setStreamProbePanel('stream: live mirror', capped);
    }

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
            // Fall through to raw extraction.
        }

        const messages = Object.values(data.mapping)
            .map((node) => node.message)
            .filter((message): message is NonNullable<(typeof data.mapping)[string]['message']> => !!message);
        const assistantTexts = messages
            .filter((message) => message.author.role === 'assistant')
            .flatMap((message) => message.content.parts ?? [])
            .filter((part) => typeof part === 'string' && part.trim().length > 0);
        return assistantTexts.join('\n\n').trim();
    }

    async function resolveStreamDoneFallbackSnapshot(
        conversationId: string,
    ): Promise<ConversationData | RawCaptureSnapshot | unknown | null> {
        if (!currentAdapter) {
            return null;
        }
        const snapshot = await requestPageSnapshot(conversationId);
        return snapshot ?? buildIsolatedDomSnapshot(currentAdapter, conversationId);
    }

    function ingestStreamDoneSnapshot(
        conversationId: string,
        snapshot: ConversationData | RawCaptureSnapshot | unknown,
    ): void {
        if (!currentAdapter) {
            return;
        }
        if (isConversationDataLike(snapshot)) {
            interceptionManager.ingestConversationData(snapshot, 'stream-done-snapshot');
            return;
        }
        if (isRawCaptureSnapshot(snapshot)) {
            const replayUrls = getRawSnapshotReplayUrls(currentAdapter, conversationId, snapshot);
            for (const replayUrl of replayUrls) {
                interceptionManager.ingestInterceptedData({
                    url: replayUrl,
                    data: snapshot.data,
                    platform: snapshot.platform ?? currentAdapter.name,
                });
                const cachedReplay = interceptionManager.getConversation(conversationId);
                if (cachedReplay && evaluateReadinessForData(cachedReplay).ready) {
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

    function logStreamDoneSnapshotCaptured(conversationId: string): void {
        if (!currentAdapter) {
            return;
        }
        logger.info('Stream done snapshot fallback captured', {
            platform: currentAdapter.name,
            conversationId,
        });
    }

    async function tryStreamDoneSnapshotCapture(conversationId: string, attemptId: string): Promise<boolean> {
        if (!currentAdapter || isAttemptDisposedOrSuperseded(attemptId)) {
            return false;
        }

        logStreamDoneSnapshotRequested(conversationId);

        const fallbackSnapshot = await resolveStreamDoneFallbackSnapshot(conversationId);
        if (!fallbackSnapshot) {
            return false;
        }

        try {
            ingestStreamDoneSnapshot(conversationId, fallbackSnapshot);
        } catch {
            return false;
        }

        const cached = interceptionManager.getConversation(conversationId);
        const captured = !!cached && evaluateReadinessForData(cached).ready;
        if (captured) {
            logStreamDoneSnapshotCaptured(conversationId);
        }
        return captured;
    }

    function logStreamDoneSnapshotRequested(conversationId: string): void {
        if (!currentAdapter) {
            return;
        }
        logger.info('Stream done snapshot fallback requested', {
            platform: currentAdapter.name,
            conversationId,
        });
    }

    type StreamDoneProbeContext = {
        adapter: LLMPlatform;
        conversationId: string;
        attemptId: string;
        probeKey: string;
        controller: AbortController;
    };

    async function createStreamDoneProbeContext(
        conversationId: string,
        hintedAttemptId?: string,
    ): Promise<StreamDoneProbeContext | null> {
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
        const probeKey = `${currentAdapter.name}:${conversationId}:${Date.now()}`;
        return {
            adapter: currentAdapter,
            conversationId,
            attemptId,
            probeKey,
            controller,
        };
    }

    function registerStreamDoneProbeStart(context: StreamDoneProbeContext): void {
        lastStreamProbeKey = context.probeKey;
        lastStreamProbeConversationId = context.conversationId;
        setStreamProbePanel('stream-done: fetching conversation', `conversationId=${context.conversationId}`);
        logger.info('Stream done probe start', {
            platform: context.adapter.name,
            conversationId: context.conversationId,
        });
    }

    function setStreamDonePanelWithMirror(conversationId: string, title: string, body: string): void {
        setStreamProbePanel(title, withPreservedLiveMirrorSnapshot(conversationId, title, body));
    }

    async function handleStreamDoneNoCandidates(context: StreamDoneProbeContext): Promise<void> {
        const capturedFromSnapshot = await tryStreamDoneSnapshotCapture(context.conversationId, context.attemptId);
        if (capturedFromSnapshot) {
            const cached = interceptionManager.getConversation(context.conversationId);
            const cachedText = cached ? extractResponseTextForProbe(cached) : '';
            const body = cachedText.length > 0 ? cachedText : '(captured via snapshot fallback)';
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
    }

    function shouldAbortStreamDoneProbe(context: StreamDoneProbeContext): boolean {
        return context.controller.signal.aborted || isAttemptDisposedOrSuperseded(context.attemptId);
    }

    async function fetchStreamDoneCandidate(
        context: StreamDoneProbeContext,
        apiUrl: string,
    ): Promise<{ ok: boolean; parsed?: ConversationData; body?: string }> {
        try {
            const response = await fetch(apiUrl, { credentials: 'include', signal: context.controller.signal });
            if (!response.ok) {
                return { ok: false };
            }
            const text = await response.text();
            const parsed = context.adapter.parseInterceptedData(text, apiUrl);
            if (!parsed?.conversation_id || parsed.conversation_id !== context.conversationId) {
                return { ok: false };
            }
            const body = extractResponseTextForProbe(parsed);
            return {
                ok: true,
                parsed,
                body: body.length > 0 ? body : '(empty response text)',
            };
        } catch {
            return { ok: false };
        }
    }

    function emitStreamDoneProbeSuccessPanel(context: StreamDoneProbeContext, body: string): void {
        if (lastStreamProbeKey !== context.probeKey) {
            return;
        }
        setStreamDonePanelWithMirror(context.conversationId, 'stream-done: fetched full text', body);
    }

    async function tryRunStreamDoneCandidateFetches(
        context: StreamDoneProbeContext,
        apiUrls: string[],
    ): Promise<boolean> {
        for (const apiUrl of apiUrls) {
            if (shouldAbortStreamDoneProbe(context)) {
                return true;
            }
            const result = await fetchStreamDoneCandidate(context, apiUrl);
            if (!result.ok || !result.body) {
                continue;
            }
            emitStreamDoneProbeSuccessPanel(context, result.body);
            logger.info('Stream done probe success', {
                platform: context.adapter.name,
                conversationId: context.conversationId,
                textLength: result.body.length,
            });
            return true;
        }
        return false;
    }

    async function tryShowStreamDoneFallbackPanel(context: StreamDoneProbeContext): Promise<void> {
        if (isStreamProbeKeyStale(context.probeKey)) {
            return;
        }

        if (showStreamDoneCachedReadyPanel(context.conversationId)) {
            return;
        }

        const capturedFromSnapshot = await tryStreamDoneSnapshotCapture(context.conversationId, context.attemptId);
        if (capturedFromSnapshot) {
            showStreamDoneSnapshotPanel(context.conversationId);
            return;
        }

        setStreamDonePanelWithMirror(
            context.conversationId,
            'stream-done: awaiting canonical capture',
            `Conversation stream completed for ${context.conversationId}. Waiting for canonical capture.`,
        );
    }

    function isStreamProbeKeyStale(probeKey: string): boolean {
        return lastStreamProbeKey !== probeKey;
    }

    function showStreamDoneCachedReadyPanel(conversationId: string): boolean {
        const cached = interceptionManager.getConversation(conversationId);
        if (!cached || !evaluateReadinessForData(cached).ready) {
            return false;
        }
        const cachedText = extractResponseTextForProbe(cached);
        const body = cachedText.length > 0 ? cachedText : '(captured cache ready; no assistant text extracted)';
        setStreamDonePanelWithMirror(conversationId, 'stream-done: using captured cache', body);
        return true;
    }

    function showStreamDoneSnapshotPanel(conversationId: string): void {
        const snapshotCached = interceptionManager.getConversation(conversationId);
        const snapshotText = snapshotCached ? extractResponseTextForProbe(snapshotCached) : '';
        const snapshotBody = snapshotText.length > 0 ? snapshotText : '(captured via snapshot fallback)';
        setStreamDonePanelWithMirror(
            conversationId,
            'stream-done: degraded snapshot captured',
            `${snapshotBody}\n\nAwaiting canonical capture. Force Save appears only if stabilization times out.`,
        );
    }

    function finalizeStreamDoneProbe(context: StreamDoneProbeContext): void {
        streamProbeControllers.delete(context.attemptId);
        void probeLease.release(context.conversationId, context.attemptId).catch((error) => {
            logger.debug('Probe lease release failed after stream-done probe finalize', {
                conversationId: context.conversationId,
                attemptId: context.attemptId,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }

    async function runStreamDoneProbe(conversationId: string, hintedAttemptId?: string): Promise<void> {
        const context = await createStreamDoneProbeContext(conversationId, hintedAttemptId);
        if (!context) {
            return;
        }

        try {
            registerStreamDoneProbeStart(context);
            const apiUrls = getFetchUrlCandidates(context.adapter, context.conversationId);
            if (apiUrls.length === 0) {
                await handleStreamDoneNoCandidates(context);
                return;
            }

            const succeeded = await tryRunStreamDoneCandidateFetches(context, apiUrls);
            if (succeeded) {
                return;
            }

            await tryShowStreamDoneFallbackPanel(context);
            logger.warn('Stream done probe failed', {
                platform: context.adapter.name,
                conversationId: context.conversationId,
            });
        } finally {
            finalizeStreamDoneProbe(context);
        }
    }

    function buildExportPayloadForFormat(data: ConversationData, format: ExportFormat): unknown {
        if (format !== 'common') {
            return data;
        }

        try {
            return buildCommonExport(data, currentAdapter?.name ?? 'Unknown');
        } catch (error) {
            logger.error('Failed to build common export format, falling back to original.', error);
            return data;
        }
    }

    function attachExportMeta(payload: unknown, meta: ExportMeta): unknown {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return payload;
        }
        const payloadRecord = payload as Record<string, unknown>;
        const existingMeta =
            payloadRecord.__blackiya && typeof payloadRecord.__blackiya === 'object'
                ? (payloadRecord.__blackiya as Record<string, unknown>)
                : {};
        return {
            ...payloadRecord,
            __blackiya: {
                ...existingMeta,
                exportMeta: meta,
            },
        };
    }

    async function buildExportPayload(data: ConversationData, meta: ExportMeta): Promise<unknown> {
        const format = await getExportFormat();
        const payload = buildExportPayloadForFormat(data, format);
        return attachExportMeta(payload, meta);
    }

    function resolveSaveReadiness(
        conversationId: string | null,
    ): { conversationId: string; decision: ReadinessDecision; allowDegraded: boolean } | null {
        if (!conversationId) {
            return null;
        }
        const decision = resolveReadinessDecision(conversationId);
        return {
            conversationId,
            decision,
            allowDegraded: decision.mode === 'degraded_manual_only',
        };
    }

    function maybeIngestFreshSnapshotForForceSave(conversationId: string, freshSnapshot: unknown): boolean {
        if (!freshSnapshot || !isConversationDataLike(freshSnapshot)) {
            return false;
        }
        interceptionManager.ingestConversationData(freshSnapshot, 'force-save-snapshot-recovery');
        const cached = interceptionManager.getConversation(conversationId);
        if (!cached) {
            return false;
        }
        const freshReadiness = evaluateReadinessForData(cached);
        if (!freshReadiness.ready) {
            return false;
        }
        markCanonicalCaptureMeta(conversationId);
        ingestSfeCanonicalSample(cached, resolveAttemptId(conversationId));
        refreshButtonState(conversationId);
        logger.info('Force Save recovered via fresh snapshot — using canonical path', {
            conversationId,
        });
        return true;
    }

    async function recoverCanonicalBeforeForceSave(conversationId: string): Promise<boolean> {
        const freshSnapshot = await requestPageSnapshot(conversationId);
        if (maybeIngestFreshSnapshotForForceSave(conversationId, freshSnapshot)) {
            return true;
        }

        await warmFetchConversationSnapshot(conversationId, 'force-save');
        refreshButtonState(conversationId);
        const nextDecision = resolveReadinessDecision(conversationId);
        return nextDecision.mode !== 'degraded_manual_only';
    }

    function confirmDegradedForceSave(): boolean {
        if (typeof window.confirm !== 'function') {
            return true;
        }
        return window.confirm('Force Save may export partial data because canonical capture timed out. Continue?');
    }

    async function handleSaveClick(): Promise<void> {
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

    async function handleCopyClick(): Promise<void> {
        if (!currentAdapter) {
            return;
        }
        const data = await getConversationData();
        if (!data) {
            return;
        }

        try {
            const exportPayload = await buildExportPayload(data, getCaptureMeta(data.conversation_id));
            await navigator.clipboard.writeText(JSON.stringify(exportPayload, null, 2));
            logger.info('Copied conversation to clipboard');
            buttonManager.setSuccess('copy');
        } catch (error) {
            handleError('copy', error);
            buttonManager.setLoading(false, 'copy');
        }
    }

    async function handleCalibrationClick(): Promise<void> {
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

    function setCalibrationStatus(status: 'idle' | 'waiting' | 'capturing' | 'success' | 'error'): void {
        calibrationState = status;
        runnerState.calibrationState = status;
        buttonManager.setCalibrationState(status, {
            timestampLabel:
                status === 'success' ? formatCalibrationTimestampLabel(rememberedCalibrationUpdatedAt) : null,
        });
    }

    function markCalibrationSuccess(conversationId: string): void {
        setCalibrationStatus('success');
        refreshButtonState(conversationId);
    }

    function markCalibrationError(message: string, data?: unknown): void {
        setCalibrationStatus('error');
        logger.warn(message, data);
    }

    function getFetchUrlCandidates(adapter: LLMPlatform, conversationId: string): string[] {
        const urls: string[] = [];
        const multi = adapter.buildApiUrls?.(conversationId) ?? [];
        for (const url of multi) {
            if (typeof url === 'string' && url.length > 0 && !urls.includes(url)) {
                urls.push(url);
            }
        }

        const primary = adapter.buildApiUrl?.(conversationId);
        if (primary && !urls.includes(primary)) {
            urls.unshift(primary);
        }

        const currentOrigin = window.location.origin;
        const filtered = urls.filter((url) => {
            try {
                return new URL(url, currentOrigin).origin === currentOrigin;
            } catch {
                return false;
            }
        });

        if (filtered.length > 0) {
            return filtered;
        }

        logger.info('Calibration fetch candidates unavailable on current origin', {
            platform: adapter.name,
            conversationId,
            candidateCount: urls.length,
            currentOrigin,
        });

        return [];
    }

    async function tryWarmFetchCandidate(
        conversationId: string,
        reason: 'initial-load' | 'conversation-switch' | 'stabilization-retry' | 'force-save',
        apiUrl: string,
    ): Promise<boolean> {
        try {
            const response = await fetch(apiUrl, { credentials: 'include' });
            if (!response.ok) {
                logger.info('Warm fetch HTTP error', {
                    conversationId,
                    reason,
                    status: response.status,
                    path: new URL(apiUrl, window.location.origin).pathname,
                });
                return false;
            }

            const text = await response.text();
            interceptionManager.ingestInterceptedData({
                url: apiUrl,
                data: text,
                platform: currentAdapter?.name ?? 'Unknown',
            });
            if (!interceptionManager.getConversation(conversationId)) {
                return false;
            }
            logger.info('Warm fetch captured conversation', {
                conversationId,
                platform: currentAdapter?.name ?? 'Unknown',
                reason,
                path: new URL(apiUrl, window.location.origin).pathname,
            });
            return true;
        } catch (err) {
            logger.info('Warm fetch network error', {
                conversationId,
                reason,
                error: err instanceof Error ? err.message : String(err),
            });
            return false;
        }
    }

    async function executeWarmFetchCandidates(
        conversationId: string,
        reason: 'initial-load' | 'conversation-switch' | 'stabilization-retry' | 'force-save',
    ): Promise<boolean> {
        if (!currentAdapter) {
            return false;
        }
        const candidates = getFetchUrlCandidates(currentAdapter as LLMPlatform, conversationId);
        if (candidates.length === 0) {
            return false;
        }

        const prioritized = candidates.slice(0, 2);
        for (const apiUrl of prioritized) {
            const success = await tryWarmFetchCandidate(conversationId, reason, apiUrl);
            if (success) {
                return true;
            }
        }

        logger.info('Warm fetch all candidates failed', { conversationId, reason });
        return false;
    }

    async function warmFetchConversationSnapshot(
        conversationId: string,
        reason: 'initial-load' | 'conversation-switch' | 'stabilization-retry' | 'force-save',
    ): Promise<boolean> {
        if (!currentAdapter) {
            return false;
        }

        const cached = interceptionManager.getConversation(conversationId);
        const captureMeta = captureMetaByConversation.get(conversationId);
        if (cached && shouldUseCachedConversationForWarmFetch(evaluateReadinessForData(cached), captureMeta)) {
            // #region agent log
            logger.info('Warm fetch skipped: cache is ready+canonical', { conversationId, reason });
            // #endregion
            return true;
        }

        const key = `${currentAdapter.name}:${conversationId}`;
        const existing = warmFetchInFlight.get(key);
        if (existing) {
            // #region agent log
            logger.info('Warm fetch dedup hit (shared in-flight promise)', { conversationId, reason });
            // #endregion
            return existing;
        }

        const run = executeWarmFetchCandidates(conversationId, reason).finally(() => {
            warmFetchInFlight.delete(key);
        });

        warmFetchInFlight.set(key, run);
        return run;
    }

    async function tryCalibrationFetch(
        conversationId: string,
        apiUrl: string,
        attempt: number,
        platformName: string,
        mode: CalibrationMode,
    ): Promise<boolean> {
        try {
            const response = await fetch(apiUrl, { credentials: 'include' });
            logger.info('Calibration fetch response', {
                attempt,
                conversationId,
                ok: response.ok,
                status: response.status,
            });

            if (!response.ok) {
                return false;
            }

            const text = await response.text();
            interceptionManager.ingestInterceptedData({
                url: apiUrl,
                data: text,
                platform: platformName,
            });

            return isCalibrationCaptureSatisfied(conversationId, mode);
        } catch (error) {
            logger.error('Calibration fetch error', error);
            return false;
        }
    }

    function prepareCalibrationContext(): { adapter: LLMPlatform; conversationId: string } | null {
        if (!currentAdapter) {
            return null;
        }

        const conversationId = resolveConversationIdForUserAction();
        if (!conversationId) {
            markCalibrationError('Calibration failed: no conversation ID');
            return null;
        }

        return { adapter: currentAdapter, conversationId };
    }

    async function runCalibrationRetries(
        adapter: LLMPlatform,
        conversationId: string,
        backoff: number[],
        mode: CalibrationMode,
    ): Promise<boolean> {
        const urls = getFetchUrlCandidates(adapter, conversationId);
        if (urls.length === 0) {
            logger.info('Calibration retries skipped: no fetch URL candidates', {
                conversationId,
                platform: adapter.name,
            });
            return false;
        }

        for (let attempt = 0; attempt < backoff.length; attempt++) {
            const waitMs = backoff[attempt];
            if (waitMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, waitMs));
            }

            for (const apiUrl of urls) {
                const captured = await tryCalibrationFetch(conversationId, apiUrl, attempt + 1, adapter.name, mode);
                if (captured) {
                    return true;
                }
            }
        }
        return false;
    }

    async function requestPageSnapshot(conversationId: string): Promise<unknown | null> {
        const requestId =
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
                ? crypto.randomUUID()
                : `snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`;

        return await new Promise((resolve) => {
            const timeout = window.setTimeout(() => {
                window.removeEventListener('message', onMessage);
                resolve(null);
            }, 2500);

            const onMessage = (event: MessageEvent) => {
                if (event.source !== window || event.origin !== window.location.origin) {
                    return;
                }
                const msg = event.data;
                if (msg?.type !== 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE' || msg.requestId !== requestId) {
                    return;
                }
                clearTimeout(timeout);
                window.removeEventListener('message', onMessage);
                resolve(msg.success ? msg.data : null);
            };

            window.addEventListener('message', onMessage);
            window.postMessage(
                stampToken({
                    type: 'BLACKIYA_PAGE_SNAPSHOT_REQUEST',
                    requestId,
                    conversationId,
                }),
                window.location.origin,
            );
        });
    }

    function hasCapturedConversation(conversationId: string): boolean {
        return !!interceptionManager.getConversation(conversationId);
    }

    function isCalibrationCaptureSatisfied(conversationId: string, mode: CalibrationMode): boolean {
        if (mode === 'auto') {
            return isConversationReadyForActions(conversationId);
        }
        return hasCapturedConversation(conversationId);
    }

    type RawCaptureSnapshot = { __blackiyaSnapshotType: 'raw-capture'; data: string; url: string; platform?: string };

    function isRawCaptureSnapshot(value: unknown): value is RawCaptureSnapshot {
        if (!value || typeof value !== 'object') {
            return false;
        }
        const candidate = value as Record<string, unknown>;
        return (
            candidate.__blackiyaSnapshotType === 'raw-capture' &&
            typeof candidate.data === 'string' &&
            typeof candidate.url === 'string'
        );
    }

    function isConversationDataLike(value: unknown): value is ConversationData {
        if (!value || typeof value !== 'object') {
            return false;
        }
        const candidate = value as Record<string, unknown>;
        return (
            typeof candidate.conversation_id === 'string' &&
            candidate.conversation_id.length > 0 &&
            !!candidate.mapping &&
            typeof candidate.mapping === 'object'
        );
    }

    function normalizeSnapshotText(text: string): string {
        return text.replace(/\s+/g, ' ').trim();
    }

    function collectSnapshotMessageCandidates(root: ParentNode): SnapshotMessageCandidate[] {
        const selectors: Array<{ selector: string; role: 'user' | 'assistant' }> = [
            { selector: '[data-message-author-role="user"]', role: 'user' },
            { selector: '[data-message-author-role="assistant"]', role: 'assistant' },
            { selector: '[class*="user-query"]', role: 'user' },
            { selector: '[class*="model-response"]', role: 'assistant' },
            { selector: 'user-query', role: 'user' },
            { selector: 'model-response', role: 'assistant' },
        ];

        const collected: SnapshotMessageCandidate[] = [];
        for (const entry of selectors) {
            const nodes = root.querySelectorAll(entry.selector);
            for (const node of nodes) {
                const text = normalizeSnapshotText((node.textContent ?? '').trim());
                if (text.length < 2) {
                    continue;
                }
                collected.push({ role: entry.role, text });
            }
        }

        // Deduplicate while preserving order
        const seen = new Set<string>();
        const deduped: SnapshotMessageCandidate[] = [];
        for (const item of collected) {
            const key = `${item.role}:${item.text}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            deduped.push(item);
        }

        return deduped;
    }

    function collectLooseGrokCandidates(root: ParentNode): SnapshotMessageCandidate[] {
        const nodes = root.querySelectorAll(
            'main article, main [data-testid*="message"], main [class*="message"], main [class*="response"]',
        );

        const rawTexts: string[] = [];
        for (const node of nodes) {
            const text = normalizeSnapshotText((node.textContent ?? '').trim());
            if (text.length < 8) {
                continue;
            }
            rawTexts.push(text);
        }

        const uniqueTexts = Array.from(new Set(rawTexts));
        if (uniqueTexts.length < 2) {
            return [];
        }

        // Fallback role assignment when Grok markup is unlabeled.
        return uniqueTexts.map((text, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            text,
        }));
    }

    function collectLastResortTextCandidates(root: ParentNode): SnapshotMessageCandidate[] {
        const containers = root.querySelectorAll('main, article, section, div');
        const snippets: string[] = [];

        for (const node of containers) {
            const text = normalizeSnapshotText((node.textContent ?? '').trim());
            if (text.length < 40 || text.length > 1200) {
                continue;
            }
            snippets.push(text);
            if (snippets.length >= 6) {
                break;
            }
        }

        const unique = Array.from(new Set(snippets));
        if (unique.length === 0) {
            return [];
        }

        if (unique.length === 1) {
            return [
                { role: 'user', text: 'Captured via calibration fallback' },
                { role: 'assistant', text: unique[0] },
            ];
        }

        return unique.slice(0, 6).map((text, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            text,
        }));
    }

    function buildConversationDataFromMessages(
        conversationId: string,
        platformName: string,
        messages: SnapshotMessageCandidate[],
    ): ConversationData | null {
        return buildRunnerSnapshotConversationData(conversationId, platformName, messages, document.title);
    }

    function buildPrimarySnapshotFromRoot(
        adapter: LLMPlatform,
        conversationId: string,
        root: ParentNode,
    ): ConversationData | null {
        const candidates = collectSnapshotMessageCandidates(root);
        if (candidates.length < 2) {
            return null;
        }
        logger.info('Calibration isolated DOM snapshot candidates found', {
            conversationId,
            platform: adapter.name,
            count: candidates.length,
        });
        return buildConversationDataFromMessages(conversationId, adapter.name, candidates);
    }

    function buildGrokFallbackSnapshotFromRoot(
        adapter: LLMPlatform,
        conversationId: string,
        root: ParentNode,
    ): ConversationData | null {
        const looseCandidates = collectLooseGrokCandidates(root);
        if (looseCandidates.length >= 2) {
            logger.info('Calibration isolated DOM Grok fallback candidates found', {
                conversationId,
                platform: adapter.name,
                count: looseCandidates.length,
            });
            return buildConversationDataFromMessages(conversationId, adapter.name, looseCandidates);
        }

        const lastResortCandidates = collectLastResortTextCandidates(root);
        if (lastResortCandidates.length < 2) {
            return null;
        }
        logger.info('Calibration isolated DOM Grok last-resort candidates found', {
            conversationId,
            platform: adapter.name,
            count: lastResortCandidates.length,
        });
        return buildConversationDataFromMessages(conversationId, adapter.name, lastResortCandidates);
    }

    function buildSnapshotFromRoot(
        adapter: LLMPlatform,
        conversationId: string,
        root: ParentNode,
    ): ConversationData | null {
        const primarySnapshot = buildPrimarySnapshotFromRoot(adapter, conversationId, root);
        if (primarySnapshot) {
            return primarySnapshot;
        }
        if (adapter.name !== 'Grok') {
            return null;
        }
        return buildGrokFallbackSnapshotFromRoot(adapter, conversationId, root);
    }

    function buildIsolatedDomSnapshot(adapter: LLMPlatform, conversationId: string): ConversationData | null {
        const roots: ParentNode[] = [];
        const main = document.querySelector('main');
        if (main) {
            roots.push(main);
        }
        roots.push(document.body);

        for (const root of roots) {
            const snapshot = buildSnapshotFromRoot(adapter, conversationId, root);
            if (snapshot) {
                return snapshot;
            }
        }

        return null;
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

        const grokCandidates = [
            `https://grok.com/rest/app-chat/conversations/${conversationId}/load-responses`,
            `https://grok.com/rest/app-chat/conversations/${conversationId}/response-node?includeThreads=true`,
            `https://grok.com/rest/app-chat/conversations_v2/${conversationId}?includeWorkspaces=true&includeTaskResult=true`,
        ];

        for (const candidate of grokCandidates) {
            if (!urls.includes(candidate)) {
                urls.push(candidate);
            }
        }

        return urls;
    }

    function getCalibrationPassiveWaitMs(adapter: LLMPlatform): number {
        if (adapter.name === 'ChatGPT') {
            return 1200;
        }
        if (adapter.name === 'Gemini' || adapter.name === 'Grok') {
            return 3500;
        }
        return 2000;
    }

    async function waitForPassiveCapture(
        adapter: LLMPlatform,
        conversationId: string,
        mode: CalibrationMode,
    ): Promise<boolean> {
        const timeoutMs = getCalibrationPassiveWaitMs(adapter);
        const intervalMs = 250;

        logger.info('Calibration passive wait start', {
            conversationId,
            platform: adapter.name,
            timeoutMs,
        });

        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            interceptionManager.flushQueuedMessages();
            if (isCalibrationCaptureSatisfied(conversationId, mode)) {
                logger.info('Calibration passive wait captured', {
                    conversationId,
                    platform: adapter.name,
                    elapsedMs: Date.now() - started,
                });
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }

        logger.info('Calibration passive wait timeout', {
            conversationId,
            platform: adapter.name,
        });
        return false;
    }

    async function waitForDomQuietPeriod(
        adapter: LLMPlatform,
        conversationId: string,
        quietMs: number,
        maxWaitMs: number,
    ): Promise<boolean> {
        const root = document.querySelector('main') ?? document.body;
        if (!root) {
            return true;
        }

        logger.info('Calibration snapshot quiet-wait start', {
            conversationId,
            platform: adapter.name,
            quietMs,
            maxWaitMs,
        });

        return await new Promise((resolve) => {
            const startedAt = Date.now();
            let lastMutationAt = Date.now();
            let done = false;

            const finalize = (settled: boolean) => {
                if (done) {
                    return;
                }
                done = true;
                observer.disconnect();
                clearInterval(intervalId);
                logger.info('Calibration snapshot quiet-wait result', {
                    conversationId,
                    platform: adapter.name,
                    settled,
                    elapsedMs: Date.now() - startedAt,
                });
                resolve(settled);
            };

            const observer = new MutationObserver(() => {
                lastMutationAt = Date.now();
            });

            observer.observe(root, {
                childList: true,
                subtree: true,
                characterData: true,
            });

            const intervalId = window.setInterval(() => {
                const now = Date.now();
                if (now - lastMutationAt >= quietMs) {
                    finalize(true);
                    return;
                }
                if (now - startedAt >= maxWaitMs) {
                    finalize(false);
                }
            }, 250);
        });
    }

    async function captureFromSnapshot(
        adapter: LLMPlatform,
        conversationId: string,
        mode: CalibrationMode,
    ): Promise<boolean> {
        const mayProceed = await ensureSnapshotQuietPeriodIfNeeded(adapter, conversationId, mode);
        if (!mayProceed) {
            return false;
        }

        let { isolatedSnapshot, effectiveSnapshot } = await loadCalibrationSnapshot(adapter, conversationId);
        if (!effectiveSnapshot) {
            return false;
        }

        ingestCalibrationSnapshot(adapter, conversationId, mode, effectiveSnapshot);

        if (!isCalibrationCaptureSatisfied(conversationId, mode) && isRawCaptureSnapshot(effectiveSnapshot)) {
            logger.info('Calibration snapshot replay did not capture conversation', {
                conversationId,
                platform: adapter.name,
                replayUrl: effectiveSnapshot.url,
            });

            if (!isolatedSnapshot) {
                isolatedSnapshot = buildIsolatedDomSnapshot(adapter, conversationId);
            }

            if (isolatedSnapshot) {
                logger.info('Calibration isolated DOM fallback after replay failure', {
                    conversationId,
                    platform: adapter.name,
                });
                interceptionManager.ingestConversationData(isolatedSnapshot, 'calibration-isolated-dom-fallback');
            }
        }

        return isCalibrationCaptureSatisfied(conversationId, mode);
    }

    async function ensureSnapshotQuietPeriodIfNeeded(
        adapter: LLMPlatform,
        conversationId: string,
        mode: CalibrationMode,
    ): Promise<boolean> {
        if (mode !== 'auto' || (adapter.name !== 'Gemini' && adapter.name !== 'ChatGPT')) {
            return true;
        }
        const quietSettled = await waitForDomQuietPeriod(adapter, conversationId, 1400, 20000);
        if (quietSettled) {
            return true;
        }
        logger.info('Calibration snapshot deferred; DOM still active', {
            conversationId,
            platform: adapter.name,
            mode,
        });
        return false;
    }

    async function loadCalibrationSnapshot(
        adapter: LLMPlatform,
        conversationId: string,
    ): Promise<{
        snapshot: unknown;
        isolatedSnapshot: ConversationData | null;
        effectiveSnapshot: unknown;
    }> {
        logger.info('Calibration snapshot fallback requested', { conversationId });
        const snapshot = await requestPageSnapshot(conversationId);
        const isolatedSnapshot = snapshot ? null : buildIsolatedDomSnapshot(adapter, conversationId);
        logger.info('Calibration snapshot fallback response', {
            conversationId,
            hasSnapshot: !!snapshot || !!isolatedSnapshot,
            source: snapshot ? 'main-world' : isolatedSnapshot ? 'isolated-dom' : 'none',
        });
        return {
            snapshot,
            isolatedSnapshot,
            effectiveSnapshot: snapshot ?? isolatedSnapshot,
        };
    }

    function ingestCalibrationSnapshot(
        adapter: LLMPlatform,
        conversationId: string,
        mode: CalibrationMode,
        effectiveSnapshot: unknown,
    ): void {
        try {
            if (isConversationDataLike(effectiveSnapshot)) {
                interceptionManager.ingestConversationData(effectiveSnapshot, 'calibration-snapshot');
                return;
            }

            if (isRawCaptureSnapshot(effectiveSnapshot)) {
                replayRawCalibrationSnapshot(adapter, conversationId, mode, effectiveSnapshot);
                return;
            }

            interceptionManager.ingestInterceptedData({
                url: `page-snapshot://${adapter.name}/${conversationId}`,
                data: JSON.stringify(effectiveSnapshot),
                platform: adapter.name,
            });
        } catch {
            // Ignore ingestion errors; handled by cache check below.
        }
    }

    function replayRawCalibrationSnapshot(
        adapter: LLMPlatform,
        conversationId: string,
        mode: CalibrationMode,
        snapshot: RawCaptureSnapshot,
    ): void {
        const replayUrls = getRawSnapshotReplayUrls(adapter, conversationId, snapshot);
        logger.info('Calibration using raw capture snapshot', {
            conversationId,
            platform: adapter.name,
            replayCandidates: replayUrls.length,
        });

        for (const replayUrl of replayUrls) {
            logger.info('Calibration raw snapshot replay attempt', {
                conversationId,
                platform: adapter.name,
                replayUrl,
            });

            interceptionManager.ingestInterceptedData({
                url: replayUrl,
                data: snapshot.data,
                platform: snapshot.platform ?? adapter.name,
            });

            if (!isCalibrationCaptureSatisfied(conversationId, mode)) {
                continue;
            }
            logger.info('Calibration raw snapshot replay captured', {
                conversationId,
                platform: adapter.name,
                replayUrl,
            });
            break;
        }
    }

    async function captureFromRetries(
        adapter: LLMPlatform,
        conversationId: string,
        mode: CalibrationMode,
    ): Promise<boolean> {
        const backoff = [0, 1500, 3000, 5000, 8000, 12000];
        return await runCalibrationRetries(adapter, conversationId, backoff, mode);
    }

    async function runCalibrationCapture(
        mode: CalibrationMode = 'manual',
        hintedConversationId?: string,
    ): Promise<void> {
        if (calibrationState === 'capturing') {
            return;
        }
        const context = prepareCalibrationContext();
        if (!context) {
            return;
        }
        const { adapter } = context;
        const conversationId = hintedConversationId || context.conversationId;

        enterCalibrationCaptureState(mode);
        const strategyOrder = logCalibrationCaptureStart(adapter, conversationId, mode);

        const successfulStep = await runCalibrationStrategySteps(adapter, conversationId, mode, strategyOrder);
        if (successfulStep) {
            applyCalibrationSuccess(mode, conversationId);
            if (shouldPersistCalibrationProfile(mode)) {
                await rememberCalibrationSuccess(adapter.name, successfulStep);
            }
            logger.info('Calibration capture succeeded', { conversationId, step: successfulStep, mode });
            return;
        }

        applyCalibrationFailure(mode, conversationId);
        logger.warn('Calibration capture failed after retries', { conversationId });
    }

    function enterCalibrationCaptureState(mode: CalibrationMode): void {
        if (mode === 'manual') {
            setCalibrationStatus('capturing');
            return;
        }
        setCalibrationStatus('capturing');
    }

    function logCalibrationCaptureStart(
        adapter: LLMPlatform,
        conversationId: string,
        mode: CalibrationMode,
    ): CalibrationStep[] {
        logger.info('Calibration capture started', { conversationId, platform: adapter.name });
        const strategyOrder = buildCalibrationOrderForMode(rememberedPreferredStep, mode, adapter.name);
        logger.info('Calibration strategy', {
            platform: adapter.name,
            steps: strategyOrder,
            mode,
            remembered: rememberedPreferredStep,
        });
        return strategyOrder;
    }

    async function runCalibrationStep(
        step: CalibrationStep,
        adapter: LLMPlatform,
        conversationId: string,
        mode: CalibrationMode,
    ): Promise<boolean> {
        if (step === 'queue-flush') {
            interceptionManager.flushQueuedMessages();
            return isCalibrationCaptureSatisfied(conversationId, mode);
        }
        if (step === 'passive-wait') {
            return await waitForPassiveCapture(adapter, conversationId, mode);
        }
        if (step === 'endpoint-retry') {
            return await captureFromRetries(adapter, conversationId, mode);
        }
        return await captureFromSnapshot(adapter, conversationId, mode);
    }

    async function runCalibrationStrategySteps(
        adapter: LLMPlatform,
        conversationId: string,
        mode: CalibrationMode,
        strategyOrder: CalibrationStep[],
    ): Promise<CalibrationStep | null> {
        for (const step of strategyOrder) {
            const captured = await runCalibrationStep(step, adapter, conversationId, mode);
            if (captured) {
                return step;
            }
        }
        return null;
    }

    function applyCalibrationSuccess(mode: CalibrationMode, conversationId: string): void {
        if (mode === 'manual') {
            markCalibrationSuccess(conversationId);
            return;
        }
        setCalibrationStatus('success');
        refreshButtonState(conversationId);
    }

    function applyCalibrationFailure(mode: CalibrationMode, conversationId: string): void {
        if (mode === 'manual') {
            setCalibrationStatus('error');
            refreshButtonState(conversationId);
            return;
        }
        setCalibrationStatus('idle');
    }

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
        const canExport = canExportConversationData(conversationId, options.allowDegraded === true, options.silent);
        if (!canExport) {
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

    function applyTitleDomFallbackIfNeeded(conversationId: string, data: ConversationData): void {
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
        if (titleDecision.title === currentTitle) {
            return;
        }
        logger.info('Title resolved from shared fallback policy', {
            conversationId,
            oldTitle: data.title,
            newTitle: titleDecision.title,
            source: titleDecision.source,
        });
        data.title = titleDecision.title;
    }

    function handleError(action: 'save' | 'copy', error: unknown, silent?: boolean) {
        logger.error(`Failed to ${action} conversation:`, error);
        if (!silent) {
            alert(`Failed to ${action} conversation. Check console for details.`);
        }
    }

    function buildExportMetaForSave(conversationId: string, allowDegraded?: boolean): ExportMeta {
        if (allowDegraded === true) {
            return {
                captureSource: 'dom_snapshot_degraded',
                fidelity: 'degraded',
                completeness: 'partial',
            };
        }
        return getCaptureMeta(conversationId);
    }

    function emitForceSaveDegradedAudit(conversationId: string, allowDegraded?: boolean): void {
        if (allowDegraded !== true) {
            return;
        }
        const attemptId = resolveAttemptId(conversationId);
        structuredLogger.emit(
            attemptId,
            'warn',
            'force_save_degraded_export',
            'Degraded manual export forced by user',
            { conversationId },
            `force-save-degraded:${conversationId}`,
        );
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
            emitForceSaveDegradedAudit(data.conversation_id, options.allowDegraded);
            if (buttonManager.exists()) {
                buttonManager.setSuccess('save');
            }
            return true;
        } catch (error) {
            handleError('save', error);
            if (buttonManager.exists()) {
                buttonManager.setLoading(false, 'save');
            }
            return false;
        }
    }

    /**
     * Returns true when the lifecycle is in an active generation phase
     * (prompt-sent or streaming). Used to gate code paths that would
     * otherwise reset lifecycle to idle when conversationId is null —
     * a legitimate state during Grok's new-conversation flow.
     */
    function isLifecycleActiveGeneration(): boolean {
        return lifecycleState === 'prompt-sent' || lifecycleState === 'streaming';
    }

    function injectSaveButton(): void {
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
            // Do not clobber active lifecycle — Grok emits lifecycle signals
            // before the conversation ID is resolved via SPA navigation.
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
    }

    function handleNavigationChange(): void {
        if (!currentAdapter) {
            return;
        }

        const newConversationId = currentAdapter.extractConversationId(window.location.href);

        if (newConversationId !== currentConversationId) {
            handleConversationSwitch(newConversationId);
        } else {
            // ID hasn't changed, but maybe DOM has (re-render), ensure button exists
            if (newConversationId && !buttonManager.exists()) {
                setTimeout(injectSaveButton, 500);
            } else {
                refreshButtonState(newConversationId || undefined);
            }
        }
    }

    function disposeInFlightAttemptsOnNavigation(preserveConversationId?: string | null): void {
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
    }

    function handleConversationSwitch(newId: string | null): void {
        const isNewConversationNavigation = !currentConversationId && isLifecycleActiveGeneration() && !!newId;
        // For null→new-conversation SPA nav during active generation,
        // skip disposal so the interceptor stream monitor keeps running.
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

        // Determine if we need to update adapter (e.g. cross-platform nav? likely not in same tab but good practice)
        const newAdapter = getPlatformAdapter(window.location.href);
        if (newAdapter && currentAdapter && newAdapter.name !== currentAdapter.name) {
            currentAdapter = newAdapter;
            runnerState.adapter = newAdapter;
            updateManagers();
            calibrationPreferenceLoaded = false;
            calibrationPreferenceLoading = null;
            void ensureCalibrationPreferenceLoaded(currentAdapter.name);
        }

        if (isNewConversationNavigation) {
            logger.info('Conversation switch → preserving active lifecycle', {
                newId,
                preservedState: lifecycleState,
            });
            // Re-associate the preserved lifecycle state with the new conversation ID
            // so downstream systems (SFE, readiness) bind to the correct conversation.
            setLifecycleState(lifecycleState, newId);
        } else {
            setTimeout(injectSaveButton, 500);
            logger.info('Conversation switch → idle', {
                newId,
                previousState: lifecycleState,
            });
            setLifecycleState('idle', newId);
        }

        void warmFetchConversationSnapshot(newId, 'conversation-switch');
        setTimeout(() => {
            if (newId) {
                maybeRunAutoCapture(newId, 'navigation');
            }
        }, 1800);
    }

    function updateManagers(): void {
        interceptionManager.updateAdapter(currentAdapter);
    }

    function resetButtonStateForNoConversation(): void {
        setCurrentConversation(null);
        // Do not clobber active lifecycle — Grok emits lifecycle signals
        // before the conversation ID is resolved via SPA navigation.
        if (!isLifecycleActiveGeneration() && lifecycleState !== 'idle') {
            setLifecycleState('idle');
        }
        buttonManager.setSaveButtonMode('default');
        buttonManager.setActionButtonsEnabled(false);
        buttonManager.setOpacity('0.6');
    }

    function shouldDisableActionsForActiveGeneration(conversationId: string): boolean {
        if (
            (lifecycleState === 'prompt-sent' || lifecycleState === 'streaming') &&
            (!currentConversationId || conversationId === currentConversationId)
        ) {
            return true;
        }
        if (lifecycleState !== 'completed' && shouldBlockActionsForGeneration(conversationId)) {
            return true;
        }
        return false;
    }

    function applyDisabledButtonState(conversationId: string): void {
        buttonManager.setSaveButtonMode('default');
        buttonManager.setActionButtonsEnabled(false);
        buttonManager.setOpacity('0.6');
        logButtonStateIfChanged(conversationId, false, '0.6');
    }

    function ensureCanonicalSampleForConversation(conversationId: string): void {
        const cached = interceptionManager.getConversation(conversationId);
        const captureMeta = getCaptureMeta(conversationId);
        if (cached && shouldIngestAsCanonicalSample(captureMeta)) {
            ingestSfeCanonicalSample(cached, attemptByConversation.get(conversationId));
        }
    }

    function applyReadyButtonState(conversationId: string, decision: ReadinessDecision): void {
        const isCanonicalReady = decision.mode === 'canonical_ready';
        const isDegraded = decision.mode === 'degraded_manual_only';
        const hasData = isCanonicalReady || isDegraded;

        buttonManager.setReadinessSource(sfeEnabled ? 'sfe' : 'legacy');
        buttonManager.setSaveButtonMode(isDegraded ? 'force-degraded' : 'default');
        if (isDegraded) {
            buttonManager.setButtonEnabled('save', true);
            buttonManager.setButtonEnabled('copy', false);
        } else {
            buttonManager.setActionButtonsEnabled(isCanonicalReady);
        }

        const opacity = hasData ? '1' : '0.6';
        buttonManager.setOpacity(opacity);

        const prevKey = lastButtonStateLog;
        const newKey = `${conversationId}:${hasData ? 'ready' : 'waiting'}:${opacity}`;
        if (prevKey !== newKey && hasData) {
            const retries = canonicalStabilizationRetryCounts.get(resolveAttemptId(conversationId)) ?? 0;
            const hasPendingTimer = canonicalStabilizationRetryTimers.has(resolveAttemptId(conversationId));
            logger.info('Button readiness transition to hasData=true', {
                conversationId,
                decisionMode: decision.mode,
                decisionReason: decision.reason,
                fidelity: getCaptureMeta(conversationId).fidelity,
                sfeEnabled,
                lifecycleState,
                retries,
                hasPendingTimer,
            });
        }
        logButtonStateIfChanged(conversationId, hasData, opacity);
    }

    function syncCalibrationDisplayFromDecision(decision: ReadinessDecision): void {
        const isCanonicalReady = decision.mode === 'canonical_ready';
        if (isCanonicalReady && calibrationState !== 'capturing') {
            setCalibrationStatus('success');
            syncCalibrationButtonDisplay();
            return;
        }
        if (!isCanonicalReady && calibrationState === 'success') {
            setCalibrationStatus('idle');
            syncCalibrationButtonDisplay();
        }
    }

    function refreshButtonState(forConversationId?: string): void {
        if (!buttonManager.exists() || !currentAdapter) {
            return;
        }
        const conversationId = forConversationId || currentAdapter.extractConversationId(window.location.href);
        if (!conversationId) {
            resetButtonStateForNoConversation();
            return;
        }
        if (shouldDisableActionsForActiveGeneration(conversationId)) {
            applyDisabledButtonState(conversationId);
            return;
        }

        ensureCanonicalSampleForConversation(conversationId);
        const decision = resolveReadinessDecision(conversationId);
        applyReadyButtonState(conversationId, decision);
        syncCalibrationDisplayFromDecision(decision);
    }

    function scheduleButtonRefresh(conversationId: string): void {
        let attempts = 0;
        const maxAttempts = 6;
        const intervalMs = 500;

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
                setTimeout(tick, intervalMs);
            } else {
                logButtonStateIfChanged(conversationId, false, '0.6');
            }
        };

        setTimeout(tick, intervalMs);
    }

    function isChatGPTGeneratingFallback(): boolean {
        const stopSelectors = [
            '[data-testid="stop-button"]',
            'button[aria-label*="Stop generating"]',
            'button[aria-label*="Stop response"]',
            'button[aria-label="Stop"]',
        ];

        for (const selector of stopSelectors) {
            const button = document.querySelector(selector) as HTMLButtonElement | null;
            if (button && !button.disabled) {
                return true;
            }
        }

        return !!document.querySelector('[data-is-streaming="true"], [data-testid*="streaming"]');
    }

    function isPlatformGenerating(adapter: LLMPlatform | null): boolean {
        if (!adapter) {
            return false;
        }
        if (adapter.isPlatformGenerating) {
            return adapter.isPlatformGenerating();
        }
        if (adapter.name === 'ChatGPT') {
            return isChatGPTGeneratingFallback();
        }
        return false;
    }

    function isLifecycleGenerationPhase(conversationId: string): boolean {
        if (lifecycleState !== 'prompt-sent' && lifecycleState !== 'streaming') {
            return false;
        }
        if (!currentConversationId) {
            return true;
        }
        return currentConversationId === conversationId;
    }

    function shouldBlockActionsForGeneration(conversationId: string): boolean {
        if (isLifecycleGenerationPhase(conversationId)) {
            return true;
        }
        if (currentAdapter?.name !== 'ChatGPT') {
            return false;
        }
        return isPlatformGenerating(currentAdapter);
    }

    function shouldLogCanonicalReadyDecision(conversationId: string): boolean {
        const now = Date.now();
        const lastLoggedAt = lastCanonicalReadyLogAtByConversation.get(conversationId);
        if (lastLoggedAt !== undefined && now - lastLoggedAt < CANONICAL_READY_LOG_TTL_MS) {
            return false;
        }
        setBoundedMapValue(lastCanonicalReadyLogAtByConversation, conversationId, now, MAX_CONVERSATION_ATTEMPTS);
        return true;
    }

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
            resolveAttemptId,
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

    function extractConversationIdFromLocation(): string | null {
        if (!currentAdapter) {
            return null;
        }
        return currentAdapter.extractConversationId(window.location.href) || null;
    }

    function resolveConversationIdForUserAction(): string | null {
        const locationConversationId = extractConversationIdFromLocation();
        if (locationConversationId) {
            return locationConversationId;
        }

        // Guard against stale in-memory IDs on /app routes.
        if (currentConversationId && window.location.href.includes(currentConversationId)) {
            return currentConversationId;
        }

        return null;
    }

    function resolveActiveConversationId(hintedConversationId?: string): string | null {
        if (hintedConversationId) {
            return hintedConversationId;
        }
        return extractConversationIdFromLocation();
    }

    function getCaptureMeta(conversationId: string): ExportMeta {
        const stored = captureMetaByConversation.get(conversationId);
        if (stored) {
            return stored;
        }
        return {
            captureSource: 'canonical_api',
            fidelity: 'high',
            completeness: 'complete',
        };
    }

    function shouldProcessFinishedSignal(conversationId: string | null, source: 'network' | 'dom'): boolean {
        if (!conversationId) {
            logger.info('Finished signal ignored: missing conversation context', { source });
            return false;
        }
        // ChatGPT emits many non-terminal network finished hints (stream_status polling).
        // Gemini/Grok finished hints should not be blocked by DOM-generation heuristics.
        const shouldApplyNetworkGenerationGuard = currentAdapter?.name === 'ChatGPT';
        if (
            source === 'network' &&
            shouldApplyNetworkGenerationGuard &&
            conversationId &&
            shouldBlockActionsForGeneration(conversationId)
        ) {
            logger.info('Finished signal blocked by generation guard', { conversationId, source });
            return false;
        }
        const now = Date.now();
        const isSameConversation = conversationId === lastResponseFinishedConversationId;
        const minIntervalMs = source === 'network' ? 4500 : 1500;
        if (isSameConversation && now - lastResponseFinishedAt < minIntervalMs) {
            logger.info('Finished signal debounced', {
                conversationId,
                source,
                elapsed: now - lastResponseFinishedAt,
                minIntervalMs,
            });
            return false;
        }
        lastResponseFinishedAt = now;
        lastResponseFinishedConversationId = conversationId;
        return true;
    }

    function shouldSkipAutoCapture(conversationId: string): boolean {
        return (
            !currentAdapter ||
            calibrationState !== 'idle' ||
            isConversationReadyForActions(conversationId, { includeDegraded: true })
        );
    }

    function scheduleDeferredAutoCapture(
        attemptKey: string,
        conversationId: string,
        reason: 'response-finished' | 'navigation',
    ): void {
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
    }

    function shouldThrottleAutoCapture(attemptKey: string): boolean {
        const now = Date.now();
        const lastAttempt = autoCaptureAttempts.get(attemptKey) ?? 0;
        if (now - lastAttempt < 12000) {
            return true;
        }
        setBoundedMapValue(autoCaptureAttempts, attemptKey, now, MAX_AUTOCAPTURE_KEYS);
        return false;
    }

    function runAutoCaptureFromPreference(conversationId: string, reason: 'response-finished' | 'navigation'): void {
        const run = () => {
            if (shouldSkipAutoCapture(conversationId)) {
                return;
            }
            if (!rememberedPreferredStep) {
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
    }

    function maybeRunAutoCapture(conversationId: string, reason: 'response-finished' | 'navigation'): void {
        if (shouldSkipAutoCapture(conversationId)) {
            return;
        }

        const adapter = currentAdapter;
        if (!adapter) {
            return;
        }
        const attemptKey = resolveAttemptId(conversationId);
        const shouldDeferWhileGenerating = adapter.name === 'ChatGPT';
        if (shouldDeferWhileGenerating && isPlatformGenerating(adapter)) {
            scheduleDeferredAutoCapture(attemptKey, conversationId, reason);
            return;
        }
        autoCaptureDeferredLogged.delete(attemptKey);

        if (shouldThrottleAutoCapture(attemptKey)) {
            return;
        }
        runAutoCaptureFromPreference(conversationId, reason);
    }

    function applyCompletedLifecycleState(conversationId: string, attemptId: string): void {
        lifecycleAttemptId = attemptId;
        lifecycleConversationId = conversationId;
        setLifecycleState('completed', conversationId);
    }

    function shouldPromoteGrokFromCanonicalCapture(
        source: 'network' | 'dom',
        cachedReady: boolean,
        lifecycle: LifecycleUiState,
    ): boolean {
        if (source !== 'network' || currentAdapter?.name !== 'Grok' || !cachedReady) {
            return false;
        }
        // Also accept 'idle': when the original lifecycle attempt was disposed by Grok SPA
        // navigation before conversation ID resolution, the lifecycle resets to idle.
        // The canonical capture arriving on a fresh attempt is the only remaining signal.
        return lifecycle === 'idle' || lifecycle === 'prompt-sent' || lifecycle === 'streaming';
    }

    function handleFinishedConversation(conversationId: string, attemptId: string, source: 'network' | 'dom'): void {
        // When the SSE stream didn't deliver a "completed" lifecycle phase
        // (e.g. tab was backgrounded and stream reader stalled), the DOM
        // completion watcher is the only signal. In that case there may be
        // no cached data yet. Trigger a stream-done probe to capture it.
        const cached = interceptionManager.getConversation(conversationId);
        const cachedReady = !!cached && evaluateReadinessForData(cached).ready;

        if (shouldPromoteGrokFromCanonicalCapture(source, cachedReady, lifecycleState)) {
            applyCompletedLifecycleState(conversationId, attemptId);
        }

        if (!cached || !cachedReady) {
            applyCompletedLifecycleState(conversationId, attemptId);
            void runStreamDoneProbe(conversationId, attemptId);
        }

        refreshButtonState(conversationId);
        scheduleButtonRefresh(conversationId);
        maybeRunAutoCapture(conversationId, 'response-finished');
    }

    function handleResponseFinished(source: 'network' | 'dom', hintedConversationId?: string): void {
        const conversationId = resolveActiveConversationId(hintedConversationId);
        if (!shouldProcessFinishedSignal(conversationId, source)) {
            return;
        }
        const attemptId = resolveAttemptId(conversationId ?? undefined);
        setActiveAttempt(attemptId);
        ingestSfeLifecycle('completed_hint', attemptId, conversationId);

        if (conversationId) {
            setCurrentConversation(conversationId);
            bindAttempt(conversationId, attemptId);
        }

        logger.info('Response finished signal', {
            source,
            attemptId,
            conversationId,
            calibrationState,
        });

        if (calibrationState === 'waiting') {
            return;
        }

        if (conversationId) {
            handleFinishedConversation(conversationId, attemptId, source);
        }
    }

    function registerCompletionWatcher(): () => void {
        if (currentAdapter?.name !== 'ChatGPT') {
            return () => {};
        }

        const isGenerating = () => isPlatformGenerating(currentAdapter);
        let wasGenerating = isGenerating();

        const checkGenerationTransition = () => {
            const generating = isGenerating();
            if (wasGenerating && !generating) {
                handleResponseFinished('dom');
            }
            wasGenerating = generating;
        };

        const observer = new MutationObserver(() => {
            checkGenerationTransition();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-testid', 'aria-label', 'data-is-streaming'],
        });

        const intervalId = window.setInterval(checkGenerationTransition, 800);

        return () => {
            observer.disconnect();
            clearInterval(intervalId);
        };
    }

    function isSameWindowOrigin(event: MessageEvent): boolean {
        return event.source === window && event.origin === window.location.origin;
    }

    function handleTitleResolvedMessage(message: unknown): boolean {
        if (
            (message as TitleResolvedMessage | undefined)?.type !== 'BLACKIYA_TITLE_RESOLVED' ||
            typeof (message as TitleResolvedMessage).conversationId !== 'string' ||
            typeof (message as TitleResolvedMessage).title !== 'string'
        ) {
            return false;
        }
        const typed = message as TitleResolvedMessage;
        const conversationId = typed.conversationId;
        const title = typed.title.trim();

        if (title.length === 0) {
            return true;
        }

        const cached = interceptionManager.getConversation(conversationId);
        const platformDefaultTitles = currentAdapter?.defaultTitles;
        const streamDecision = resolveConversationTitleByPrecedence({
            streamTitle: title,
            cachedTitle: streamResolvedTitles.get(conversationId) ?? null,
            fallbackTitle: title,
            platformDefaultTitles,
        });
        streamResolvedTitles.set(conversationId, streamDecision.title);

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
            conversationId,
            title,
            resolvedTitle: streamDecision.title,
            source: streamDecision.source,
        });
        return true;
    }

    function handleResponseFinishedMessage(message: unknown): boolean {
        if (
            (message as ResponseFinishedMessage | undefined)?.type !== 'BLACKIYA_RESPONSE_FINISHED' ||
            typeof (message as ResponseFinishedMessage).attemptId !== 'string'
        ) {
            return false;
        }
        const typed = message as ResponseFinishedMessage;
        const hintedConversationId = typeof typed.conversationId === 'string' ? typed.conversationId : undefined;
        const resolvedConversationId = resolveActiveConversationId(hintedConversationId);
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
        attachFinishedAttemptContext(resolvedConversationId, attemptId);
        if (!promoteLifecycleFromFinishedSignal(resolvedConversationId, attemptId)) {
            return true;
        }
        handleResponseFinished('network', resolvedConversationId);
        return true;
    }

    function attachFinishedAttemptContext(conversationId: string, attemptId: string): void {
        setActiveAttempt(attemptId);
        bindAttempt(conversationId, attemptId);
    }

    function promoteLifecycleFromFinishedSignal(conversationId: string, attemptId: string): boolean {
        if (lifecycleState !== 'prompt-sent' && lifecycleState !== 'streaming') {
            return true;
        }
        const shouldRejectWhileGenerating = currentAdapter?.name === 'ChatGPT';
        if (shouldRejectWhileGenerating && currentAdapter && isPlatformGenerating(currentAdapter)) {
            logger.info('RESPONSE_FINISHED rejected: platform still generating', {
                conversationId,
                attemptId,
                lifecycleState,
            });
            return false;
        }
        logger.info('RESPONSE_FINISHED promoted lifecycle to completed', {
            conversationId,
            attemptId,
            previousLifecycle: lifecycleState,
        });
        lifecycleAttemptId = attemptId;
        lifecycleConversationId = conversationId;
        setLifecycleState('completed', conversationId);
        return true;
    }

    function ingestSfeLifecycleFromWirePhase(
        phase: ResponseLifecycleMessage['phase'],
        attemptId: string,
        conversationId?: string | null,
    ): void {
        if (phase === 'prompt-sent') {
            ingestSfeLifecycle('prompt_sent', attemptId, conversationId ?? null);
            return;
        }
        if (phase === 'streaming') {
            ingestSfeLifecycle('streaming', attemptId, conversationId ?? null);
            return;
        }
        if (phase === 'completed') {
            ingestSfeLifecycle('completed_hint', attemptId, conversationId ?? null);
            return;
        }
        if (phase === 'terminated') {
            ingestSfeLifecycle('terminated_partial', attemptId, conversationId ?? null);
        }
    }

    function applyLifecyclePhaseForConversation(
        phase: ResponseLifecycleMessage['phase'],
        platform: string,
        attemptId: string,
        conversationId: string,
        source: 'direct' | 'replayed',
    ): void {
        logger.info('Lifecycle phase', {
            platform,
            phase,
            attemptId,
            conversationId,
            source,
        });

        ingestSfeLifecycleFromWirePhase(phase, attemptId, conversationId);

        if (phase === 'prompt-sent' || phase === 'streaming') {
            applyActiveLifecyclePhase(phase, attemptId, conversationId, source);
            return;
        }

        if (phase !== 'completed') {
            return;
        }

        applyCompletedLifecyclePhase(conversationId, attemptId);
    }

    function shouldBlockLifecycleRegression(
        phase: 'prompt-sent' | 'streaming',
        attemptId: string,
        conversationId: string,
        source: 'direct' | 'replayed',
    ): boolean {
        if (
            lifecycleState !== 'completed' ||
            lifecycleConversationId !== conversationId ||
            lifecycleAttemptId !== attemptId
        ) {
            return false;
        }
        logger.info('Lifecycle regression blocked', {
            from: lifecycleState,
            to: phase,
            attemptId,
            conversationId,
            source,
        });
        return true;
    }

    function applyActiveLifecyclePhase(
        phase: 'prompt-sent' | 'streaming',
        attemptId: string,
        conversationId: string,
        source: 'direct' | 'replayed',
    ): void {
        if (shouldBlockLifecycleRegression(phase, attemptId, conversationId, source)) {
            return;
        }
        if (!liveStreamPreviewByConversation.has(conversationId)) {
            setBoundedMapValue(liveStreamPreviewByConversation, conversationId, '', MAX_STREAM_PREVIEWS);
            setStreamProbePanel('stream: awaiting delta', `conversationId=${conversationId}`);
        }
        lifecycleAttemptId = attemptId;
        lifecycleConversationId = conversationId;
        setLifecycleState(phase, conversationId);
    }

    function applyCompletedLifecyclePhase(conversationId: string, attemptId: string): void {
        lifecycleAttemptId = attemptId;
        lifecycleConversationId = conversationId;
        setLifecycleState('completed', conversationId);
        if (!sfeEnabled) {
            void runStreamDoneProbe(conversationId, attemptId);
            return;
        }

        const resolution = sfe.resolve(attemptId);
        const captureMeta = getCaptureMeta(conversationId);
        const shouldRetryAfterCompletion =
            !resolution.blockingConditions.includes('stabilization_timeout') &&
            !resolution.ready &&
            (resolution.phase === 'canonical_probing' || !shouldIngestAsCanonicalSample(captureMeta));
        if (shouldRetryAfterCompletion) {
            scheduleCanonicalStabilizationRetry(conversationId, attemptId);
        }
        void runStreamDoneProbe(conversationId, attemptId);
    }

    function replayPendingLifecycleSignal(attemptId: string, conversationId: string): void {
        const pending = pendingLifecycleByAttempt.get(attemptId);
        if (!pending) {
            return;
        }
        pendingLifecycleByAttempt.delete(attemptId);
        applyLifecyclePhaseForConversation(pending.phase, pending.platform, attemptId, conversationId, 'replayed');
    }

    function parseLifecycleMessage(message: unknown): {
        phase: 'prompt-sent' | 'streaming' | 'completed' | 'terminated';
        platform: string;
        conversationId?: string;
        attemptId: string;
        originalAttemptId: string;
    } | null {
        if (
            (message as ResponseLifecycleMessage | undefined)?.type !== 'BLACKIYA_RESPONSE_LIFECYCLE' ||
            typeof (message as ResponseLifecycleMessage).attemptId !== 'string'
        ) {
            return null;
        }

        const typed = message as ResponseLifecycleMessage;
        const phase = typed.phase;
        if (!isSupportedLifecyclePhase(phase)) {
            return null;
        }

        return {
            phase,
            platform: typed.platform,
            conversationId: typeof typed.conversationId === 'string' ? typed.conversationId : undefined,
            attemptId: resolveAliasedAttemptId(typed.attemptId),
            originalAttemptId: typed.attemptId,
        };
    }

    function handleResolvedLifecycleConversation(
        phase: 'prompt-sent' | 'streaming' | 'completed' | 'terminated',
        platform: string,
        attemptId: string,
        conversationId: string,
    ): void {
        if (phase === 'prompt-sent') {
            bindAttempt(conversationId, attemptId);
        }

        if (isStaleAttemptMessage(attemptId, conversationId, 'lifecycle')) {
            return;
        }

        setCurrentConversation(conversationId);
        bindAttempt(conversationId, attemptId);
        setActiveAttempt(attemptId);
        applyLifecyclePhaseForConversation(phase, platform, attemptId, conversationId, 'direct');
    }

    function handleLifecycleMessage(message: unknown): boolean {
        const parsed = parseLifecycleMessage(message);
        if (!parsed) {
            return false;
        }

        if (!parsed.conversationId) {
            handleLifecyclePendingConversation(
                parsed.attemptId,
                parsed.phase,
                parsed.platform,
                parsed.originalAttemptId,
            );
            return true;
        }

        handleResolvedLifecycleConversation(parsed.phase, parsed.platform, parsed.attemptId, parsed.conversationId);

        return true;
    }

    function isSupportedLifecyclePhase(
        phase: ResponseLifecycleMessage['phase'],
    ): phase is 'prompt-sent' | 'streaming' | 'completed' | 'terminated' {
        return phase === 'prompt-sent' || phase === 'streaming' || phase === 'completed' || phase === 'terminated';
    }

    function handleLifecyclePendingConversation(
        attemptId: string,
        phase: 'prompt-sent' | 'streaming' | 'completed' | 'terminated',
        platform: string,
        originalAttemptId: string,
    ): void {
        cachePendingLifecycleSignal(attemptId, phase, platform);
        ingestSfeLifecycleFromWirePhase(phase, attemptId, null);
        logger.info('Lifecycle pending conversation resolution', {
            phase,
            platform,
            attemptId: originalAttemptId,
        });

        // Update UI badge immediately for pending lifecycle signals
        // so users see "Prompt Sent" / "Streaming" instead of "Idle"
        // even before the conversation ID is resolved.
        if (phase === 'prompt-sent' || phase === 'streaming') {
            lifecycleAttemptId = attemptId;
            setLifecycleState(phase);
        }
    }

    function handleStreamDeltaMessage(message: unknown): boolean {
        if (
            (message as StreamDeltaMessage | undefined)?.type !== 'BLACKIYA_STREAM_DELTA' ||
            typeof (message as StreamDeltaMessage).attemptId !== 'string'
        ) {
            return false;
        }

        const typed = message as StreamDeltaMessage;
        const text = typeof typed.text === 'string' ? typed.text : '';
        if (text.length === 0) {
            return true;
        }

        const conversationId =
            typeof typed.conversationId === 'string' && typed.conversationId.length > 0
                ? typed.conversationId
                : currentConversationId;
        const attemptId = resolveAliasedAttemptId(typed.attemptId);
        if (isStaleAttemptMessage(attemptId, conversationId ?? undefined, 'delta')) {
            return true;
        }

        if (!conversationId) {
            return true;
        }

        setActiveAttempt(attemptId);
        bindAttempt(conversationId, attemptId);
        appendLiveStreamProbeText(conversationId, text);
        return true;
    }

    function handleStreamDumpFrameMessage(message: unknown): boolean {
        if ((message as StreamDumpFrameMessage | undefined)?.type !== 'BLACKIYA_STREAM_DUMP_FRAME') {
            return false;
        }

        const typed = message as StreamDumpFrameMessage;
        if (
            typeof typed.attemptId !== 'string' ||
            typeof typed.platform !== 'string' ||
            typeof typed.text !== 'string' ||
            typeof typed.kind !== 'string'
        ) {
            return true;
        }

        if (!streamDumpEnabled) {
            return true;
        }

        if (isStaleAttemptMessage(typed.attemptId, typed.conversationId, 'delta')) {
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
    }

    function handleConversationIdResolvedMessage(message: unknown): boolean {
        if ((message as ConversationIdResolvedMessage | undefined)?.type !== 'BLACKIYA_CONVERSATION_ID_RESOLVED') {
            return false;
        }

        const typed = message as ConversationIdResolvedMessage;
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
        replayPendingLifecycleSignal(canonicalAttemptId, typed.conversationId);
        refreshButtonState(typed.conversationId);
        return true;
    }

    function handleAttemptDisposedMessage(message: unknown): boolean {
        if ((message as AttemptDisposedMessage | undefined)?.type !== 'BLACKIYA_ATTEMPT_DISPOSED') {
            return false;
        }
        const typed = message as AttemptDisposedMessage;
        if (typeof typed.attemptId !== 'string') {
            return false;
        }
        const canonicalDisposedId = resolveAliasedAttemptId(typed.attemptId);
        cancelStreamDoneProbe(canonicalDisposedId, typed.reason === 'superseded' ? 'superseded' : 'disposed');
        clearCanonicalStabilizationRetry(canonicalDisposedId);
        sfe.dispose(canonicalDisposedId);
        pendingLifecycleByAttempt.delete(canonicalDisposedId);
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
    }

    function postWindowBridgeResponse(
        requestId: string,
        success: boolean,
        options?: { data?: unknown; error?: string },
    ): void {
        window.postMessage(
            stampToken({
                type: 'BLACKIYA_GET_JSON_RESPONSE',
                requestId,
                success,
                data: options?.data,
                error: options?.error,
            }),
            window.location.origin,
        );
    }

    function handleJsonBridgeRequest(message: unknown): void {
        const typedMessage = (message as { type?: unknown; requestId?: unknown; format?: unknown } | null) ?? null;
        if (typedMessage?.type !== 'BLACKIYA_GET_JSON_REQUEST') {
            return;
        }

        if (typeof typedMessage.requestId !== 'string') {
            return;
        }

        const requestId = typedMessage.requestId;
        const requestFormat = typedMessage.format === 'common' ? 'common' : 'original';
        getConversationData({ silent: true })
            .then((data) => {
                if (!data) {
                    postWindowBridgeResponse(requestId, false, { error: 'NO_CONVERSATION_DATA' });
                    return;
                }
                const payload = buildExportPayloadForFormat(data, requestFormat);
                postWindowBridgeResponse(requestId, true, { data: payload });
            })
            .catch((error) => {
                logger.error('Failed to handle window get request:', error);
                postWindowBridgeResponse(requestId, false, { error: 'INTERNAL_ERROR' });
            });
    }

    function dispatchWindowBridgeMessage(message: unknown): void {
        const handled = dispatchRunnerMessage(message, [
            handleAttemptDisposedMessage,
            handleConversationIdResolvedMessage,
            handleStreamDeltaMessage,
            handleStreamDumpFrameMessage,
            handleTitleResolvedMessage,
            handleLifecycleMessage,
            handleResponseFinishedMessage,
        ]);
        if (!handled) {
            handleJsonBridgeRequest(message);
        }
    }

    function registerWindowBridge(): () => void {
        const handler = (event: MessageEvent) => {
            if (!isSameWindowOrigin(event)) {
                return;
            }
            if (!isValidToken(event.data)) {
                logger.debug('Dropped message with invalid session token');
                return;
            }
            dispatchWindowBridgeMessage(event.data);
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }

    function registerButtonHealthCheck(): () => void {
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
        }, 1800);

        return () => clearInterval(intervalId);
    }

    function logButtonStateIfChanged(conversationId: string, hasData: boolean, opacity: string): void {
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

    // -- Boot Sequence --

    const url = window.location.href;
    currentAdapter = getPlatformAdapter(url);
    runnerState.adapter = currentAdapter;

    if (!currentAdapter) {
        logger.warn('No matching platform adapter for this URL');
        return;
    }

    logger.info(`Content script running for ${currentAdapter.name}`);
    logger.info('Runner init', {
        platform: currentAdapter.name,
        url: window.location.href,
    });

    // Update managers with initial adapter
    updateManagers();
    void ensureCalibrationPreferenceLoaded(currentAdapter.name);
    void loadSfeSettings();
    void loadStreamDumpSetting();

    const storageChangeListener: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, areaName) => {
        if (areaName !== 'local') {
            return;
        }
        if (changes[STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_ENABLED]) {
            streamDumpEnabled = changes[STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_ENABLED]?.newValue === true;
            emitStreamDumpConfig();
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

    // Start listening
    interceptionManager.start();
    navigationManager.start();
    cleanupWindowBridge = registerWindowBridge();
    cleanupCompletionWatcher = registerCompletionWatcher();
    cleanupButtonHealthCheck = registerButtonHealthCheck();

    // V2.1-023: Recover background-completed tabs when user switches to them
    const handleVisibilityChange = () => {
        if (document.hidden) {
            return;
        }
        const conversationId = currentAdapter?.extractConversationId(window.location.href) ?? currentConversationId;
        if (!conversationId) {
            return;
        }
        const decision = resolveReadinessDecision(conversationId);
        if (decision.mode === 'canonical_ready') {
            return;
        }

        // Tab just became visible — try to recover degraded conversations
        logger.info('Tab became visible — reattempting capture', {
            conversationId,
            currentMode: decision.mode,
            reason: decision.reason,
        });

        const attemptId = resolveAttemptId(conversationId);

        // Re-arm canonical recovery if timed out
        if (decision.mode === 'degraded_manual_only') {
            maybeRestartCanonicalRecoveryAfterTimeout(conversationId, attemptId);
        }

        // Try fresh snapshot (tab is now visible, DOM should be rendered)
        void requestPageSnapshot(conversationId).then((snapshot) => {
            if (!snapshot || !isConversationDataLike(snapshot)) {
                return;
            }
            interceptionManager.ingestConversationData(snapshot, 'visibility-recovery-snapshot');
            const cached = interceptionManager.getConversation(conversationId);
            if (!cached) {
                return;
            }
            const readiness = evaluateReadinessForData(cached);
            if (readiness.ready) {
                markCanonicalCaptureMeta(conversationId);
                ingestSfeCanonicalSample(cached, attemptId);
            }
            refreshButtonState(conversationId);
        });

        // Also attempt warm fetch in parallel
        void warmFetchConversationSnapshot(conversationId, 'force-save').then(() => {
            refreshButtonState(conversationId);
        });
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Initial injection
    setCurrentConversation(currentAdapter.extractConversationId(url));
    injectSaveButton();
    if (currentConversationId) {
        void warmFetchConversationSnapshot(currentConversationId, 'initial-load');
    }

    // Retry logic for initial load (sometimes SPA takes time to render header)
    const retryIntervals = [1000, 2000, 5000];
    for (const delay of retryIntervals) {
        const timeoutId = window.setTimeout(() => {
            if (!buttonManager.exists()) {
                injectSaveButton();
            }
        }, delay);
        retryTimeoutIds.push(timeoutId);
    }

    let cleanedUp = false;
    let beforeUnloadHandler: (() => void) | null = null;

    function disposeTeardownAttempts(): void {
        const disposed = sfe.disposeAll();
        for (const attemptId of disposed) {
            cancelStreamDoneProbe(attemptId, 'teardown');
            clearCanonicalStabilizationRetry(attemptId);
            clearProbeLeaseRetry(attemptId);
            emitAttemptDisposed(attemptId, 'teardown');
        }
    }

    function clearRunnerRetryTimers(): void {
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
    }

    function cancelAllStreamProbeControllers(): void {
        for (const controller of streamProbeControllers.values()) {
            try {
                controller.abort();
            } catch {
                // ignore
            }
        }
        streamProbeControllers.clear();
    }

    function clearStartupRetryTimeouts(): void {
        for (const timeoutId of retryTimeoutIds) {
            clearTimeout(timeoutId);
        }
        retryTimeoutIds.length = 0;
    }

    function detachBeforeUnload(): void {
        if (!beforeUnloadHandler) {
            return;
        }
        window.removeEventListener('beforeunload', beforeUnloadHandler);
        beforeUnloadHandler = null;
    }

    function clearRunnerControlHandle(): void {
        const globalControl = (window as unknown as Record<string, unknown>)[RUNNER_CONTROL_KEY] as
            | RunnerControl
            | undefined;
        if (globalControl === runnerControl) {
            delete (window as unknown as Record<string, unknown>)[RUNNER_CONTROL_KEY];
        }
    }

    const cleanupRuntime = () => {
        if (cleanedUp) {
            return;
        }
        cleanedUp = true;
        try {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            disposeTeardownAttempts();
            interceptionManager.stop();
            navigationManager.stop();
            buttonManager.remove();
            cleanupWindowBridge?.();
            cleanupCompletionWatcher?.();
            cleanupButtonHealthCheck?.();
            browser.storage.onChanged.removeListener(storageChangeListener);
            clearRunnerRetryTimers();
            cancelAllStreamProbeControllers();
            probeLease.dispose();
            clearStartupRetryTimeouts();
            autoCaptureDeferredLogged.clear();
            detachBeforeUnload();
            clearRunnerControlHandle();
        } catch (error) {
            logger.debug('Error during cleanup:', error);
        }
    };

    beforeUnloadHandler = cleanupRuntime;
    window.addEventListener('beforeunload', cleanupRuntime);
    runnerControl.cleanup = cleanupRuntime;
}
