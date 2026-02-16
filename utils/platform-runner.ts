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
import {
    type AttemptDisposedMessage,
    type ConversationIdResolvedMessage,
    createAttemptId,
    type ResponseFinishedMessage,
    type ResponseLifecycleMessage,
    type StreamDeltaMessage,
    type StreamDumpConfigMessage,
    type StreamDumpFrameMessage,
    type TitleResolvedMessage,
} from '@/utils/protocol/messages';
import { DEFAULT_EXPORT_FORMAT, type ExportFormat, STORAGE_KEYS } from '@/utils/settings';
import { shouldIngestAsCanonicalSample, shouldUseCachedConversationForWarmFetch } from '@/utils/sfe/capture-fidelity';
import { CrossTabProbeLease } from '@/utils/sfe/cross-tab-probe-lease';
import { ReadinessGate } from '@/utils/sfe/readiness-gate';
import { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';
import type { ExportMeta, LifecyclePhase, PlatformReadiness, ReadinessDecision } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';
import { ButtonManager } from '@/utils/ui/button-manager';

interface SnapshotMessageCandidate {
    role: 'user' | 'assistant';
    text: string;
}

type CalibrationStep = 'queue-flush' | 'passive-wait' | 'endpoint-retry' | 'page-snapshot';
type CalibrationMode = 'manual' | 'auto';
type LifecycleUiState = 'idle' | 'prompt-sent' | 'streaming' | 'completed';
type CalibrationUiState = 'idle' | 'waiting' | 'capturing' | 'success' | 'error';
const CANONICAL_STABILIZATION_RETRY_DELAY_MS = 1150;
const CANONICAL_STABILIZATION_MAX_RETRIES = 6;
const CANONICAL_STABILIZATION_TIMEOUT_GRACE_MS = 400;
const SFE_STABILIZATION_MAX_WAIT_MS = 3200;
const PROBE_LEASE_TTL_MS = 5000;
const PROBE_LEASE_RETRY_GRACE_MS = 500;
const MAX_CONVERSATION_ATTEMPTS = 250;
const MAX_STREAM_PREVIEWS = 150;
const MAX_AUTOCAPTURE_KEYS = 400;

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

    const reordered = [preferredStep, ...defaultOrder.filter((step) => step !== preferredStep)];
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

export function runPlatform(): void {
    let currentAdapter: LLMPlatform | null = null;
    let currentConversationId: string | null = null;
    let cleanupWindowBridge: (() => void) | null = null;
    let cleanupCompletionWatcher: (() => void) | null = null;
    let cleanupButtonHealthCheck: (() => void) | null = null;
    const retryTimeoutIds: number[] = [];
    let lastButtonStateLog = '';
    let calibrationState: CalibrationUiState = 'idle';
    let lifecycleState: LifecycleUiState = 'idle';
    let lastStreamProbeKey = '';
    let lastStreamProbeConversationId: string | null = null;
    const liveStreamPreviewByConversation = new Map<string, string>();
    const preservedLiveStreamSnapshotByConversation = new Map<string, string>();
    let streamDumpEnabled = false;
    const streamProbeControllers = new Map<string, AbortController>();
    const probeLeaseRetryTimers = new Map<string, number>();
    const canonicalStabilizationRetryTimers = new Map<string, number>();
    const canonicalStabilizationRetryCounts = new Map<string, number>();
    const canonicalStabilizationStartedAt = new Map<string, number>();
    const timeoutWarningByAttempt = new Set<string>();
    let lastResponseFinishedAt = 0;
    let lastResponseFinishedConversationId: string | null = null;
    let rememberedPreferredStep: CalibrationStep | null = null;
    let rememberedCalibrationUpdatedAt: string | null = null;
    let calibrationPreferenceLoaded = false;
    let calibrationPreferenceLoading: Promise<void> | null = null;
    let sfeEnabled = true;
    let probeLeaseEnabled = false;
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
    const attemptByConversation = new Map<string, string>();
    const attemptAliasForward = new Map<string, string>();
    const captureMetaByConversation = new Map<string, ExportMeta>();
    const probeLease = new CrossTabProbeLease();
    const streamResolvedTitles = new Map<string, string>();
    let activeAttemptId: string | null = null;

    function setBoundedMapValue<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
        if (map.has(key)) {
            map.delete(key);
        }
        map.set(key, value);
        while (map.size > maxEntries) {
            const oldest = map.keys().next().value as K | undefined;
            if (oldest === undefined) {
                break;
            }
            map.delete(oldest);
        }
    }

    function addBoundedSetValue<T>(set: Set<T>, value: T, maxEntries: number): void {
        if (set.has(value)) {
            return;
        }
        set.add(value);
        while (set.size > maxEntries) {
            const oldest = set.values().next().value as T | undefined;
            if (oldest === undefined) {
                break;
            }
            set.delete(oldest);
        }
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

    // 2. Data Manager
    const interceptionManager = new InterceptionManager((capturedId, data, meta) => {
        // Apply stream-resolved title if the cached data has a stale/placeholder title
        const streamTitle = streamResolvedTitles.get(capturedId);
        if (streamTitle && data.title !== streamTitle) {
            data.title = streamTitle;
        }

        currentConversationId = capturedId;
        if (meta?.attemptId) {
            activeAttemptId = meta.attemptId;
            bindAttempt(capturedId, meta.attemptId);
        }
        const source = meta?.source ?? 'network';
        const isSnapshotSource = source.includes('snapshot') || source.includes('dom');
        if (isSnapshotSource) {
            const existingDecision = resolveReadinessDecision(capturedId);
            if (existingDecision.mode === 'canonical_ready') {
                markCanonicalCaptureMeta(capturedId);
            } else {
                markSnapshotCaptureMeta(capturedId);
            }
            structuredLogger.emit(
                resolveAttemptId(capturedId),
                'info',
                'snapshot_degraded_mode_used',
                'Snapshot-based capture marked as degraded/manual-only',
                { conversationId: capturedId, source },
                `snapshot-degraded:${capturedId}:${source}`,
            );
            const retryAttemptIdResolved = resolveAttemptId(capturedId);
            // #region agent log
            logger.info('Snapshot retry decision', {
                conversationId: capturedId,
                lifecycleState,
                willSchedule: lifecycleState === 'completed',
                attemptId: retryAttemptIdResolved,
            });
            // #endregion
            if (lifecycleState === 'completed') {
                scheduleCanonicalStabilizationRetry(capturedId, retryAttemptIdResolved);
            }
        } else {
            const effectiveAttemptId = resolveAliasedAttemptId(meta?.attemptId ?? resolveAttemptId(capturedId));
            maybeRestartCanonicalRecoveryAfterTimeout(capturedId, effectiveAttemptId);
            // Canonical API data is high-fidelity by definition. Promote fidelity
            // immediately so that stabilization retry can ingest second samples via
            // shouldIngestAsCanonicalSample. Without this, a prior degraded snapshot
            // capture blocks the retry loop and the SFE never reaches captured_ready.
            // #region agent log
            logger.info('Network source: marking canonical fidelity', {
                conversationId: capturedId,
                source,
                effectiveAttemptId,
                readinessReady: evaluateReadinessForData(data).ready,
            });
            // #endregion
            markCanonicalCaptureMeta(capturedId);
            ingestSfeCanonicalSample(data, effectiveAttemptId);
        }
        refreshButtonState(capturedId);
        if (evaluateReadinessForData(data).ready) {
            handleResponseFinished('network', capturedId);
        }
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
        if (conversationId) {
            const mapped = attemptByConversation.get(conversationId);
            if (mapped) {
                return resolveAliasedAttemptId(mapped);
            }
        }
        if (activeAttemptId) {
            return resolveAliasedAttemptId(activeAttemptId);
        }
        const prefix = (currentAdapter?.name ?? 'attempt').toLowerCase().replace(/\s+/g, '-');
        const created = createAttemptId(prefix);
        activeAttemptId = created;
        return created;
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
        if (!conversationId) {
            return null;
        }
        const mapped = attemptByConversation.get(conversationId);
        const canonicalMapped = mapped ? resolveAliasedAttemptId(mapped) : null;
        if (!canonicalMapped || canonicalMapped === canonicalAttemptId) {
            return null;
        }
        return canonicalMapped;
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

    function tryAcquireProbeLease(conversationId: string, attemptId: string): boolean {
        if (!probeLeaseEnabled) {
            return true;
        }

        const claim = probeLease.claim(conversationId, attemptId, PROBE_LEASE_TTL_MS);
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
        const timerId = canonicalStabilizationRetryTimers.get(attemptId);
        if (timerId !== undefined) {
            logger.info('Stabilization retry cleared', { attemptId });
            clearTimeout(timerId);
            canonicalStabilizationRetryTimers.delete(attemptId);
        }
        canonicalStabilizationRetryCounts.delete(attemptId);
        canonicalStabilizationStartedAt.delete(attemptId);
        timeoutWarningByAttempt.delete(attemptId);
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
            // #region agent log
            logger.info('Timeout: max retries exhausted with no pending timer', {
                attemptId,
                retries,
                hasPendingTimer,
                maxRetries: CANONICAL_STABILIZATION_MAX_RETRIES,
            });
            // #endregion
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
        if (elapsed >= timeoutMs) {
            // #region agent log
            logger.info('Timeout: elapsed exceeded max wait', {
                attemptId,
                retries,
                elapsed,
                timeoutMs,
            });
            // #endregion
        }
        return elapsed >= timeoutMs;
    }

    async function processCanonicalStabilizationRetryTick(
        conversationId: string,
        attemptId: string,
        retries: number,
    ): Promise<void> {
        canonicalStabilizationRetryTimers.delete(attemptId);
        canonicalStabilizationRetryCounts.set(attemptId, retries + 1);

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
        if (disposed) {
            return;
        }

        if (mappedMismatch) {
            return;
        }

        const fetchSucceeded = await warmFetchConversationSnapshot(conversationId, 'stabilization-retry');

        const cached = interceptionManager.getConversation(conversationId);
        if (!cached) {
            scheduleCanonicalStabilizationRetry(conversationId, attemptId);
            return;
        }

        const captureMeta = getCaptureMeta(conversationId);
        if (!shouldIngestAsCanonicalSample(captureMeta)) {
            // The cached data is degraded (from a DOM snapshot) and the warm
            // fetch failed — typically because the ChatGPT API returns 404 for
            // requests made from the ISOLATED content script world (missing
            // Authorization header). If the cached snapshot already passes
            // readiness, promote it to canonical so the SFE can stabilize.
            const readinessResult = evaluateReadinessForData(cached);
            if (!fetchSucceeded && readinessResult.ready) {
                // #region agent log
                logger.info('Promoting ready snapshot to canonical (API unreachable)', {
                    conversationId,
                    retries: retries + 1,
                });
                // #endregion
                markCanonicalCaptureMeta(conversationId);
                ingestSfeCanonicalSample(cached, attemptId);
                scheduleCanonicalStabilizationRetry(conversationId, attemptId);
                refreshButtonState(conversationId);
                return;
            }
            // The cached snapshot is stale (e.g., assistant-missing for thinking
            // models where the DOM hadn't rendered the response at initial capture
            // time). Re-request a fresh DOM snapshot — the DOM has likely finished
            // rendering by now.
            if (!fetchSucceeded && !readinessResult.ready) {
                logger.info('Snapshot promotion skipped: readiness check failed, re-requesting snapshot', {
                    conversationId,
                    retries: retries + 1,
                    reason: readinessResult.reason,
                    terminal: readinessResult.terminal,
                });
                const freshSnapshot = await requestPageSnapshot(conversationId);
                const freshData =
                    freshSnapshot ?? (currentAdapter ? buildIsolatedDomSnapshot(currentAdapter, conversationId) : null);
                if (freshData) {
                    if (isConversationDataLike(freshData)) {
                        interceptionManager.ingestConversationData(freshData, 'stabilization-retry-snapshot');
                    } else {
                        interceptionManager.ingestInterceptedData({
                            url: `stabilization-retry-snapshot://${currentAdapter?.name ?? 'unknown'}/${conversationId}`,
                            data: JSON.stringify(freshData),
                            platform: currentAdapter?.name ?? 'unknown',
                        });
                    }

                    const recheckCached = interceptionManager.getConversation(conversationId);
                    const recheckReadiness = recheckCached ? evaluateReadinessForData(recheckCached) : null;
                    if (recheckReadiness?.ready) {
                        logger.info('Fresh snapshot promoted to canonical after re-request', {
                            conversationId,
                            retries: retries + 1,
                        });
                        markCanonicalCaptureMeta(conversationId);
                        ingestSfeCanonicalSample(recheckCached!, attemptId);
                        scheduleCanonicalStabilizationRetry(conversationId, attemptId);
                        refreshButtonState(conversationId);
                        return;
                    }
                }
            }
            scheduleCanonicalStabilizationRetry(conversationId, attemptId);
            refreshButtonState(conversationId);
            return;
        }

        ingestSfeCanonicalSample(cached, attemptId);
        refreshButtonState(conversationId);
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
        window.postMessage(payload, window.location.origin);
    }

    function emitStreamDumpConfig(): void {
        const payload: StreamDumpConfigMessage = {
            type: 'BLACKIYA_STREAM_DUMP_CONFIG',
            enabled: streamDumpEnabled,
        };
        window.postMessage(payload, window.location.origin);
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
            const result = await browser.storage.local.get([
                STORAGE_KEYS.SFE_ENABLED,
                STORAGE_KEYS.PROBE_LEASE_ENABLED,
            ]);
            sfeEnabled = result[STORAGE_KEYS.SFE_ENABLED] !== false;
            probeLeaseEnabled = result[STORAGE_KEYS.PROBE_LEASE_ENABLED] === true;
            logger.info('SFE settings loaded', {
                sfeEnabled,
                probeLeaseEnabled,
            });
        } catch (error) {
            logger.warn('Failed to load SFE settings. Falling back to defaults.', error);
            sfeEnabled = true;
            probeLeaseEnabled = false;
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

    async function rememberCalibrationSuccess(platformName: string, step: CalibrationStep): Promise<void> {
        try {
            rememberedPreferredStep = step;
            rememberedCalibrationUpdatedAt = new Date().toISOString();
            calibrationPreferenceLoaded = true;

            await saveCalibrationProfileV2({
                schemaVersion: 2,
                platform: platformName,
                strategy: strategyFromPreferredStep(step),
                disabledSources: ['dom_hint', 'snapshot_fallback'],
                timingsMs: {
                    passiveWait: step === 'passive-wait' ? 900 : step === 'endpoint-retry' ? 1400 : 2200,
                    domQuietWindow: step === 'passive-wait' ? 500 : 800,
                    maxStabilizationWait:
                        step === 'passive-wait' ? 12_000 : step === 'endpoint-retry' ? 18_000 : 30_000,
                },
                retry: {
                    maxAttempts: step === 'passive-wait' ? 3 : step === 'endpoint-retry' ? 4 : 6,
                    backoffMs:
                        step === 'passive-wait'
                            ? [300, 800, 1300]
                            : step === 'endpoint-retry'
                              ? [400, 900, 1600, 2400]
                              : [800, 1600, 2600, 3800, 5200, 7000],
                    hardTimeoutMs: step === 'passive-wait' ? 12_000 : step === 'endpoint-retry' ? 20_000 : 30_000,
                },
                updatedAt: new Date().toISOString(),
                lastModifiedBy: 'manual',
            });
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

    function setLifecycleState(state: LifecycleUiState, conversationId?: string): void {
        lifecycleState = state;
        buttonManager.setLifecycleState(state);

        if (!buttonManager.exists()) {
            return;
        }

        if (state === 'completed') {
            const targetConversationId = conversationId || currentConversationId || undefined;
            if (targetConversationId) {
                refreshButtonState(targetConversationId);
                scheduleButtonRefresh(targetConversationId);
            }
            return;
        }

        // While prompt is in-flight/streaming, disable actions to avoid partial exports.
        if (state === 'prompt-sent' || state === 'streaming') {
            buttonManager.setActionButtonsEnabled(false);
            buttonManager.setOpacity('0.6');
        }
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
        const capped = next.length > 16_000 ? `...${next.slice(-15_500)}` : next;
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

    async function tryStreamDoneSnapshotCapture(conversationId: string, attemptId: string): Promise<boolean> {
        if (!currentAdapter || isAttemptDisposedOrSuperseded(attemptId)) {
            return false;
        }

        logger.info('Stream done snapshot fallback requested', {
            platform: currentAdapter.name,
            conversationId,
        });

        const snapshot = await requestPageSnapshot(conversationId);
        const fallbackSnapshot = snapshot ?? buildIsolatedDomSnapshot(currentAdapter, conversationId);
        if (!fallbackSnapshot) {
            return false;
        }

        try {
            if (isConversationDataLike(fallbackSnapshot)) {
                interceptionManager.ingestConversationData(fallbackSnapshot, 'stream-done-snapshot');
            } else if (isRawCaptureSnapshot(fallbackSnapshot)) {
                const replayUrls = getRawSnapshotReplayUrls(currentAdapter, conversationId, fallbackSnapshot);
                for (const replayUrl of replayUrls) {
                    interceptionManager.ingestInterceptedData({
                        url: replayUrl,
                        data: fallbackSnapshot.data,
                        platform: fallbackSnapshot.platform ?? currentAdapter.name,
                    });
                    const cachedReplay = interceptionManager.getConversation(conversationId);
                    if (cachedReplay && evaluateReadinessForData(cachedReplay).ready) {
                        break;
                    }
                }
            } else {
                interceptionManager.ingestInterceptedData({
                    url: `stream-snapshot://${currentAdapter.name}/${conversationId}`,
                    data: JSON.stringify(fallbackSnapshot),
                    platform: currentAdapter.name,
                });
            }
        } catch {
            return false;
        }

        const cached = interceptionManager.getConversation(conversationId);
        const captured = !!cached && evaluateReadinessForData(cached).ready;
        if (captured) {
            logger.info('Stream done snapshot fallback captured', {
                platform: currentAdapter.name,
                conversationId,
            });
        }
        return captured;
    }

    async function runStreamDoneProbe(conversationId: string, hintedAttemptId?: string): Promise<void> {
        if (!currentAdapter) {
            return;
        }

        const attemptId = hintedAttemptId ?? resolveAttemptId(conversationId);
        if (isAttemptDisposedOrSuperseded(attemptId)) {
            return;
        }
        if (!tryAcquireProbeLease(conversationId, attemptId)) {
            return;
        }
        cancelStreamDoneProbe(attemptId, 'superseded');
        const controller = new AbortController();
        streamProbeControllers.set(attemptId, controller);

        try {
            const probeKey = `${currentAdapter.name}:${conversationId}:${Date.now()}`;
            lastStreamProbeKey = probeKey;
            lastStreamProbeConversationId = conversationId;
            setStreamProbePanel('stream-done: fetching conversation', `conversationId=${conversationId}`);
            logger.info('Stream done probe start', {
                platform: currentAdapter.name,
                conversationId,
            });

            const apiUrls = getFetchUrlCandidates(currentAdapter, conversationId);
            if (apiUrls.length === 0) {
                const capturedFromSnapshot = await tryStreamDoneSnapshotCapture(conversationId, attemptId);
                if (capturedFromSnapshot) {
                    const cached = interceptionManager.getConversation(conversationId);
                    const cachedText = cached ? extractResponseTextForProbe(cached) : '';
                    const body = cachedText.length > 0 ? cachedText : '(captured via snapshot fallback)';
                    setStreamProbePanel(
                        'stream-done: degraded snapshot captured',
                        withPreservedLiveMirrorSnapshot(
                            conversationId,
                            'stream-done: degraded snapshot captured',
                            `${body}\n\nAwaiting canonical capture. Force Save appears only if stabilization times out.`,
                        ),
                    );
                    return;
                }
                setStreamProbePanel(
                    'stream-done: no api url candidates',
                    withPreservedLiveMirrorSnapshot(
                        conversationId,
                        'stream-done: no api url candidates',
                        `conversationId=${conversationId}`,
                    ),
                );
                logger.warn('Stream done probe has no URL candidates', {
                    platform: currentAdapter.name,
                    conversationId,
                });
                return;
            }

            for (const apiUrl of apiUrls) {
                if (controller.signal.aborted || isAttemptDisposedOrSuperseded(attemptId)) {
                    return;
                }
                try {
                    const response = await fetch(apiUrl, { credentials: 'include', signal: controller.signal });
                    if (!response.ok) {
                        continue;
                    }
                    const text = await response.text();
                    const parsed = currentAdapter.parseInterceptedData(text, apiUrl);
                    if (!parsed?.conversation_id) {
                        continue;
                    }
                    if (parsed.conversation_id !== conversationId) {
                        continue;
                    }
                    const body = extractResponseTextForProbe(parsed);
                    const normalizedBody = body.length > 0 ? body : '(empty response text)';
                    if (lastStreamProbeKey === probeKey) {
                        setStreamProbePanel(
                            'stream-done: fetched full text',
                            withPreservedLiveMirrorSnapshot(
                                conversationId,
                                'stream-done: fetched full text',
                                normalizedBody,
                            ),
                        );
                    }
                    logger.info('Stream done probe success', {
                        platform: currentAdapter.name,
                        conversationId,
                        textLength: normalizedBody.length,
                    });
                    return;
                } catch {
                    // probe fetch failed; continue to next candidate
                }
            }

            if (lastStreamProbeKey === probeKey) {
                const cached = interceptionManager.getConversation(conversationId);
                if (cached && evaluateReadinessForData(cached).ready) {
                    const cachedText = extractResponseTextForProbe(cached);
                    const body =
                        cachedText.length > 0 ? cachedText : '(captured cache ready; no assistant text extracted)';
                    setStreamProbePanel(
                        'stream-done: using captured cache',
                        withPreservedLiveMirrorSnapshot(conversationId, 'stream-done: using captured cache', body),
                    );
                } else {
                    const capturedFromSnapshot = await tryStreamDoneSnapshotCapture(conversationId, attemptId);
                    if (capturedFromSnapshot) {
                        const snapshotCached = interceptionManager.getConversation(conversationId);
                        const snapshotText = snapshotCached ? extractResponseTextForProbe(snapshotCached) : '';
                        const snapshotBody =
                            snapshotText.length > 0 ? snapshotText : '(captured via snapshot fallback)';
                        setStreamProbePanel(
                            'stream-done: degraded snapshot captured',
                            withPreservedLiveMirrorSnapshot(
                                conversationId,
                                'stream-done: degraded snapshot captured',
                                `${snapshotBody}\n\nAwaiting canonical capture. Force Save appears only if stabilization times out.`,
                            ),
                        );
                        return;
                    }
                    setStreamProbePanel(
                        'stream-done: awaiting canonical capture',
                        withPreservedLiveMirrorSnapshot(
                            conversationId,
                            'stream-done: awaiting canonical capture',
                            `Conversation stream completed for ${conversationId}. Waiting for canonical capture.`,
                        ),
                    );
                }
            }
            logger.warn('Stream done probe failed', {
                platform: currentAdapter.name,
                conversationId,
            });
        } finally {
            streamProbeControllers.delete(attemptId);
            if (probeLeaseEnabled) {
                probeLease.release(conversationId, attemptId);
            }
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

    async function handleSaveClick(): Promise<void> {
        if (!currentAdapter) {
            return;
        }
        const conversationId = currentAdapter.extractConversationId(window.location.href) || currentConversationId;
        let decision = conversationId ? resolveReadinessDecision(conversationId) : null;
        let allowDegraded = decision?.mode === 'degraded_manual_only';

        if (allowDegraded) {
            const confirmed =
                typeof window.confirm === 'function'
                    ? window.confirm(
                          'Force Save may export partial data because canonical capture timed out. Continue?',
                      )
                    : true;
            if (!confirmed) {
                return;
            }

            if (conversationId) {
                await warmFetchConversationSnapshot(conversationId, 'force-save');
                refreshButtonState(conversationId);
                decision = resolveReadinessDecision(conversationId);
                allowDegraded = decision.mode === 'degraded_manual_only';
            }
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

        calibrationState = 'waiting';
        buttonManager.setCalibrationState('waiting');
        logger.info('Calibration armed. Click Done when response is complete.');
    }

    function setCalibrationStatus(status: 'idle' | 'waiting' | 'capturing' | 'success' | 'error'): void {
        calibrationState = status;
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

        const run = (async () => {
            const candidates = getFetchUrlCandidates(currentAdapter as LLMPlatform, conversationId);
            if (candidates.length === 0) {
                return false;
            }

            const prioritized = candidates.slice(0, 2);
            for (const apiUrl of prioritized) {
                try {
                    const response = await fetch(apiUrl, { credentials: 'include' });
                    if (!response.ok) {
                        // #region agent log
                        logger.info('Warm fetch HTTP error', {
                            conversationId,
                            reason,
                            status: response.status,
                            path: new URL(apiUrl, window.location.origin).pathname,
                        });
                        // #endregion
                        continue;
                    }
                    const text = await response.text();
                    interceptionManager.ingestInterceptedData({
                        url: apiUrl,
                        data: text,
                        platform: currentAdapter?.name ?? 'Unknown',
                    });
                    if (interceptionManager.getConversation(conversationId)) {
                        logger.info('Warm fetch captured conversation', {
                            conversationId,
                            platform: currentAdapter?.name ?? 'Unknown',
                            reason,
                            path: new URL(apiUrl, window.location.origin).pathname,
                        });
                        return true;
                    }
                } catch (err) {
                    // #region agent log
                    logger.info('Warm fetch network error', {
                        conversationId,
                        reason,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    // #endregion
                }
            }
            // #region agent log
            logger.info('Warm fetch all candidates failed', { conversationId, reason });
            // #endregion
            return false;
        })().finally(() => {
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

        const conversationId = currentAdapter.extractConversationId(window.location.href) || currentConversationId;
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
                {
                    type: 'BLACKIYA_PAGE_SNAPSHOT_REQUEST',
                    requestId,
                    conversationId,
                },
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

    function isRawCaptureSnapshot(
        value: unknown,
    ): value is { __blackiyaSnapshotType: 'raw-capture'; data: string; url: string; platform?: string } {
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
        if (messages.length === 0) {
            return null;
        }

        const mapping: ConversationData['mapping'] = {};
        const now = Date.now() / 1000;

        for (let index = 0; index < messages.length; index++) {
            const msg = messages[index];
            const id = `snapshot-${index + 1}`;
            mapping[id] = {
                id,
                message: {
                    id,
                    author: {
                        role: msg.role,
                        name: msg.role === 'user' ? 'User' : platformName,
                        metadata: {},
                    },
                    create_time: now + index,
                    update_time: now + index,
                    content: {
                        content_type: 'text',
                        parts: [msg.text],
                    },
                    status: 'finished_successfully',
                    end_turn: true,
                    weight: 1,
                    metadata: {},
                    recipient: 'all',
                    channel: null,
                },
                parent: index === 0 ? null : `snapshot-${index}`,
                children: index === messages.length - 1 ? [] : [`snapshot-${index + 2}`],
            };
        }

        return {
            title: document.title || `${platformName} Conversation`,
            create_time: now,
            update_time: now + messages.length,
            conversation_id: conversationId,
            mapping,
            current_node: `snapshot-${messages.length}`,
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'snapshot',
            safe_urls: [],
            blocked_urls: [],
        };
    }

    function buildIsolatedDomSnapshot(adapter: LLMPlatform, conversationId: string): ConversationData | null {
        const roots: ParentNode[] = [];
        const main = document.querySelector('main');
        if (main) {
            roots.push(main);
        }
        roots.push(document.body);

        for (const root of roots) {
            const candidates = collectSnapshotMessageCandidates(root);
            if (candidates.length >= 2) {
                logger.info('Calibration isolated DOM snapshot candidates found', {
                    conversationId,
                    platform: adapter.name,
                    count: candidates.length,
                });
                return buildConversationDataFromMessages(conversationId, adapter.name, candidates);
            }

            if (adapter.name === 'Grok') {
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
                if (lastResortCandidates.length >= 2) {
                    logger.info('Calibration isolated DOM Grok last-resort candidates found', {
                        conversationId,
                        platform: adapter.name,
                        count: lastResortCandidates.length,
                    });
                    return buildConversationDataFromMessages(conversationId, adapter.name, lastResortCandidates);
                }
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
        if (mode === 'auto' && (adapter.name === 'Gemini' || adapter.name === 'ChatGPT')) {
            const quietSettled = await waitForDomQuietPeriod(adapter, conversationId, 1400, 20000);
            if (!quietSettled) {
                logger.info('Calibration snapshot deferred; DOM still active', {
                    conversationId,
                    platform: adapter.name,
                    mode,
                });
                return false;
            }
        }

        logger.info('Calibration snapshot fallback requested', { conversationId });
        const snapshot = await requestPageSnapshot(conversationId);
        let isolatedSnapshot = snapshot ? null : buildIsolatedDomSnapshot(adapter, conversationId);
        logger.info('Calibration snapshot fallback response', {
            conversationId,
            hasSnapshot: !!snapshot || !!isolatedSnapshot,
            source: snapshot ? 'main-world' : isolatedSnapshot ? 'isolated-dom' : 'none',
        });

        const effectiveSnapshot = snapshot ?? isolatedSnapshot;
        if (!effectiveSnapshot) {
            return false;
        }

        try {
            if (isConversationDataLike(effectiveSnapshot)) {
                interceptionManager.ingestConversationData(effectiveSnapshot, 'calibration-snapshot');
            } else if (isRawCaptureSnapshot(effectiveSnapshot)) {
                const replayUrls = getRawSnapshotReplayUrls(adapter, conversationId, effectiveSnapshot);
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
                        data: effectiveSnapshot.data,
                        platform: effectiveSnapshot.platform ?? adapter.name,
                    });

                    if (isCalibrationCaptureSatisfied(conversationId, mode)) {
                        logger.info('Calibration raw snapshot replay captured', {
                            conversationId,
                            platform: adapter.name,
                            replayUrl,
                        });
                        break;
                    }
                }
            } else {
                interceptionManager.ingestInterceptedData({
                    url: `page-snapshot://${adapter.name}/${conversationId}`,
                    data: JSON.stringify(effectiveSnapshot),
                    platform: adapter.name,
                });
            }
        } catch {
            // Ignore ingestion errors; handled by cache check below.
        }

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

        if (mode === 'manual') {
            setCalibrationStatus('capturing');
        } else {
            calibrationState = 'capturing';
        }
        logger.info('Calibration capture started', { conversationId, platform: adapter.name });
        const strategyOrder = buildCalibrationOrderForMode(rememberedPreferredStep, mode, adapter.name);
        logger.info('Calibration strategy', {
            platform: adapter.name,
            steps: strategyOrder,
            mode,
            remembered: rememberedPreferredStep,
        });

        for (const step of strategyOrder) {
            let captured = false;
            if (step === 'queue-flush') {
                interceptionManager.flushQueuedMessages();
                captured = isCalibrationCaptureSatisfied(conversationId, mode);
            } else if (step === 'passive-wait') {
                captured = await waitForPassiveCapture(adapter, conversationId, mode);
            } else if (step === 'endpoint-retry') {
                captured = await captureFromRetries(adapter, conversationId, mode);
            } else if (step === 'page-snapshot') {
                captured = await captureFromSnapshot(adapter, conversationId, mode);
            }

            if (!captured) {
                continue;
            }

            if (mode === 'manual') {
                markCalibrationSuccess(conversationId);
            } else {
                calibrationState = 'success';
                refreshButtonState(conversationId);
            }

            if (shouldPersistCalibrationProfile(mode)) {
                await rememberCalibrationSuccess(adapter.name, step);
            }
            logger.info('Calibration capture succeeded', { conversationId, step, mode });
            return;
        }

        if (mode === 'manual') {
            setCalibrationStatus('error');
            refreshButtonState(conversationId);
        } else {
            calibrationState = 'idle';
        }
        logger.warn('Calibration capture failed after retries', { conversationId });
    }

    async function getConversationData(options: { silent?: boolean; allowDegraded?: boolean } = {}) {
        if (!currentAdapter) {
            return null;
        }

        const conversationId = currentAdapter.extractConversationId(window.location.href) || currentConversationId;
        if (!conversationId) {
            logger.error('No conversation ID found in URL');
            if (!options.silent) {
                alert('Please select a conversation first.');
            }
            return null;
        }

        const data = interceptionManager.getConversation(conversationId);
        if (!data) {
            logger.warn('No data captured for this conversation yet.');
            if (!options.silent) {
                alert(
                    'Conversation data not yet captured. Please refresh the page or wait for the conversation to load.',
                );
            }
            return null;
        }

        const decision = resolveReadinessDecision(conversationId);
        const allowDegraded = options.allowDegraded === true;
        const canExportNow =
            decision.mode === 'canonical_ready' || (allowDegraded && decision.mode === 'degraded_manual_only');
        if (!canExportNow || shouldBlockActionsForGeneration(conversationId)) {
            logger.warn('Conversation is still generating; export blocked until completion.', {
                conversationId,
                platform: currentAdapter.name,
                reason: decision.reason,
            });
            if (!options.silent) {
                alert(
                    decision.mode === 'degraded_manual_only'
                        ? 'Canonical capture timed out. Use Force Save to export potentially incomplete data.'
                        : 'Response is still generating. Please wait for completion, then try again.',
                );
            }
            return null;
        }
        return data;
    }

    function handleError(action: 'save' | 'copy', error: unknown, silent?: boolean) {
        logger.error(`Failed to ${action} conversation:`, error);
        if (!silent) {
            alert(`Failed to ${action} conversation. Check console for details.`);
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
            const filename = currentAdapter.formatFilename(data);
            const exportMeta: ExportMeta =
                options.allowDegraded === true
                    ? {
                          captureSource: 'dom_snapshot_degraded',
                          fidelity: 'degraded',
                          completeness: 'partial',
                      }
                    : getCaptureMeta(data.conversation_id);
            const exportPayload = await buildExportPayload(data, exportMeta);
            downloadAsJSON(exportPayload, filename);
            logger.info(`Saved conversation: ${filename}.json`);
            if (options.allowDegraded === true) {
                const attemptId = resolveAttemptId(data.conversation_id);
                structuredLogger.emit(
                    attemptId,
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
            handleError('save', error);
            if (buttonManager.exists()) {
                buttonManager.setLoading(false, 'save');
            }
            return false;
        }
    }

    function injectSaveButton(): void {
        const conversationId = currentAdapter?.extractConversationId(window.location.href) || null;
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
            const hasFallbackData =
                !!currentConversationId && !!interceptionManager.getConversation(currentConversationId);
            buttonManager.setActionButtonsEnabled(hasFallbackData);
            buttonManager.setOpacity(hasFallbackData ? '1' : '0.6');
            return;
        }

        buttonManager.setActionButtonsEnabled(true);
        currentConversationId = conversationId;

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

    function disposeInFlightAttemptsOnNavigation(): void {
        const disposedAttemptIds = sfe.getAttemptTracker().disposeAllForRouteChange();
        if (disposedAttemptIds.length > 0) {
            logger.info('Navigation disposing attempts', {
                count: disposedAttemptIds.length,
                attemptIds: disposedAttemptIds,
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
        disposeInFlightAttemptsOnNavigation();
        if (!newId) {
            currentConversationId = null;
            setLifecycleState('idle');
            setTimeout(injectSaveButton, 300);
            return;
        }

        buttonManager.remove();
        currentConversationId = newId;

        // Determine if we need to update adapter (e.g. cross-platform nav? likely not in same tab but good practice)
        const newAdapter = getPlatformAdapter(window.location.href);
        if (newAdapter && currentAdapter && newAdapter.name !== currentAdapter.name) {
            currentAdapter = newAdapter;
            updateManagers();
            calibrationPreferenceLoaded = false;
            calibrationPreferenceLoading = null;
            void ensureCalibrationPreferenceLoaded(currentAdapter.name);
        }

        setTimeout(injectSaveButton, 500);
        logger.info('Conversation switch → idle', {
            newId,
            previousState: lifecycleState,
        });
        setLifecycleState('idle', newId);
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

    function refreshButtonState(forConversationId?: string): void {
        if (!buttonManager.exists() || !currentAdapter) {
            return;
        }
        const conversationId = forConversationId || currentAdapter.extractConversationId(window.location.href);
        if (!conversationId) {
            return;
        }
        if (
            (lifecycleState === 'prompt-sent' || lifecycleState === 'streaming') &&
            (!currentConversationId || conversationId === currentConversationId)
        ) {
            buttonManager.setSaveButtonMode('default');
            buttonManager.setActionButtonsEnabled(false);
            buttonManager.setOpacity('0.6');
            logButtonStateIfChanged(conversationId, false, '0.6');
            return;
        }

        if (lifecycleState !== 'completed' && shouldBlockActionsForGeneration(conversationId)) {
            buttonManager.setSaveButtonMode('default');
            buttonManager.setActionButtonsEnabled(false);
            buttonManager.setOpacity('0.6');
            logButtonStateIfChanged(conversationId, false, '0.6');
            return;
        }

        const cached = interceptionManager.getConversation(conversationId);
        const captureMeta = getCaptureMeta(conversationId);
        if (cached && shouldIngestAsCanonicalSample(captureMeta)) {
            ingestSfeCanonicalSample(cached, attemptByConversation.get(conversationId));
        }
        const decision = resolveReadinessDecision(conversationId);
        buttonManager.setReadinessSource(sfeEnabled ? 'sfe' : 'legacy');
        const isCanonicalReady = decision.mode === 'canonical_ready';
        const isDegraded = decision.mode === 'degraded_manual_only';
        const hasData = isCanonicalReady || isDegraded;

        buttonManager.setSaveButtonMode(isDegraded ? 'force-degraded' : 'default');
        if (isDegraded) {
            buttonManager.setButtonEnabled('save', true);
            buttonManager.setButtonEnabled('copy', false);
        } else {
            buttonManager.setActionButtonsEnabled(isCanonicalReady);
        }
        const opacity = hasData ? '1' : '0.6';
        buttonManager.setOpacity(opacity);
        // #region agent log
        const prevKey = lastButtonStateLog;
        const newKey = `${conversationId}:${hasData ? 'ready' : 'waiting'}:${opacity}`;
        if (prevKey !== newKey && hasData) {
            const retries = canonicalStabilizationRetryCounts.get(resolveAttemptId(conversationId)) ?? 0;
            const hasPendingTimer = canonicalStabilizationRetryTimers.has(resolveAttemptId(conversationId));
            logger.info('Button readiness transition to hasData=true', {
                conversationId,
                decisionMode: decision.mode,
                decisionReason: decision.reason,
                fidelity: captureMeta.fidelity,
                sfeEnabled,
                lifecycleState,
                retries,
                hasPendingTimer,
            });
        }
        // #endregion
        logButtonStateIfChanged(conversationId, hasData, opacity);
        if (isCanonicalReady && calibrationState !== 'capturing') {
            calibrationState = 'success';
            syncCalibrationButtonDisplay();
        } else if (!isCanonicalReady && calibrationState === 'success') {
            calibrationState = 'idle';
            syncCalibrationButtonDisplay();
        }
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

    function isChatGPTGenerating(): boolean {
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

    function hasEnabledStopControl(selectors: string[]): boolean {
        for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            for (const element of elements) {
                if (!(element instanceof HTMLButtonElement)) {
                    continue;
                }
                if (!element.disabled) {
                    return true;
                }
            }
        }
        return false;
    }

    function isGeminiGenerating(): boolean {
        const stopSelectors = [
            'button[aria-label*="Stop"]',
            'button[aria-label*="stop"]',
            'button[title*="Stop"]',
            'button[title*="stop"]',
            'button[data-test-id*="stop"]',
            'button[data-testid*="stop"]',
        ];

        if (hasEnabledStopControl(stopSelectors)) {
            return true;
        }

        return !!document.querySelector(
            '[data-test-id*="thinking"], [data-testid*="thinking"], [class*="generating"], [class*="streaming"]',
        );
    }

    function isGrokGenerating(): boolean {
        const stopSelectors = [
            'button[aria-label*="Stop"]',
            'button[aria-label*="stop"]',
            'button[data-testid*="stop"]',
        ];

        if (hasEnabledStopControl(stopSelectors)) {
            return true;
        }

        return !!document.querySelector('[data-testid*="typing"], [class*="generating"], [class*="streaming"]');
    }

    function isPlatformGenerating(adapter: LLMPlatform | null): boolean {
        if (!adapter) {
            return false;
        }
        if (adapter.name === 'ChatGPT') {
            return isChatGPTGenerating();
        }
        if (adapter.name === 'Gemini') {
            return isGeminiGenerating();
        }
        if (adapter.name === 'Grok') {
            return isGrokGenerating();
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
        // Fallback path when lifecycle events are missing.
        return isPlatformGenerating(currentAdapter);
    }

    function resolveReadinessDecision(conversationId: string): ReadinessDecision {
        const data = interceptionManager.getConversation(conversationId);
        if (!data) {
            return {
                ready: false,
                mode: 'awaiting_stabilization',
                reason: 'no_canonical_data',
            };
        }

        const readiness = evaluateReadinessForData(data);
        const captureMeta = getCaptureMeta(conversationId);

        if (!sfeEnabled) {
            const ready = readiness.ready;
            // #region agent log
            if (ready) {
                logger.info('Readiness decision: SFE disabled, legacy ready', {
                    conversationId,
                    fidelity: captureMeta.fidelity,
                    readinessReason: readiness.reason,
                });
            }
            // #endregion
            return {
                ready,
                mode: ready ? 'canonical_ready' : 'awaiting_stabilization',
                reason: ready ? 'legacy_ready' : readiness.reason,
            };
        }

        const sfeResolution = sfe.resolveByConversation(conversationId);
        const sfeReady = !!sfeResolution?.ready;
        logSfeMismatchIfNeeded(conversationId, readiness.ready);
        if (sfeReady && readiness.ready && captureMeta.fidelity === 'high') {
            // #region agent log
            logger.info('Readiness decision: canonical_ready', {
                conversationId,
                fidelity: captureMeta.fidelity,
                sfeReady,
                legacyReady: readiness.ready,
            });
            // #endregion
            return {
                ready: true,
                mode: 'canonical_ready',
                reason: 'canonical_ready',
            };
        }

        const attemptId = resolveAttemptId(conversationId);
        const hasTimeout =
            sfeResolution?.blockingConditions.includes('stabilization_timeout') === true ||
            (captureMeta.fidelity === 'degraded' && hasCanonicalStabilizationTimedOut(attemptId));
        if (hasTimeout) {
            // #region agent log
            const timeoutRetries = canonicalStabilizationRetryCounts.get(attemptId) ?? 0;
            const timeoutHasPendingTimer = canonicalStabilizationRetryTimers.has(attemptId);
            const timeoutStartedAt = canonicalStabilizationStartedAt.get(attemptId);
            logger.info('Readiness decision: degraded_manual_only (timeout)', {
                conversationId,
                attemptId,
                fidelity: captureMeta.fidelity,
                sfeTimeout: sfeResolution?.blockingConditions.includes('stabilization_timeout'),
                localRetries: timeoutRetries,
                hasPendingTimer: timeoutHasPendingTimer,
                startedAt: timeoutStartedAt,
                elapsed: timeoutStartedAt ? Date.now() - timeoutStartedAt : null,
                maxRetries: CANONICAL_STABILIZATION_MAX_RETRIES,
            });
            // #endregion
            emitTimeoutWarningOnce(attemptId, conversationId);
            return {
                ready: false,
                mode: 'degraded_manual_only',
                reason: 'stabilization_timeout',
            };
        }

        timeoutWarningByAttempt.delete(attemptId);

        if (captureMeta.fidelity === 'degraded') {
            return {
                ready: false,
                mode: 'awaiting_stabilization',
                reason: 'snapshot_degraded_capture',
            };
        }

        return {
            ready: false,
            mode: 'awaiting_stabilization',
            reason: sfeResolution?.reason ?? readiness.reason,
        };
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

    function resolveActiveConversationId(hintedConversationId?: string): string | null {
        if (hintedConversationId) {
            return hintedConversationId;
        }
        if (!currentAdapter) {
            return currentConversationId;
        }
        return currentAdapter.extractConversationId(window.location.href) || currentConversationId;
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
        if (source === 'network' && conversationId && shouldBlockActionsForGeneration(conversationId)) {
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

    function maybeRunAutoCapture(conversationId: string, reason: 'response-finished' | 'navigation'): void {
        if (
            !currentAdapter ||
            calibrationState !== 'idle' ||
            isConversationReadyForActions(conversationId, { includeDegraded: true })
        ) {
            return;
        }

        const attemptKey = resolveAttemptId(conversationId);
        const shouldDeferWhileGenerating = currentAdapter.name === 'ChatGPT';
        if (shouldDeferWhileGenerating && isPlatformGenerating(currentAdapter)) {
            if (!autoCaptureRetryTimers.has(attemptKey)) {
                if (!autoCaptureDeferredLogged.has(attemptKey)) {
                    logger.info('Auto calibration deferred: response still generating', {
                        platform: currentAdapter.name,
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
            return;
        }
        autoCaptureDeferredLogged.delete(attemptKey);

        const now = Date.now();
        const lastAttempt = autoCaptureAttempts.get(attemptKey) ?? 0;
        if (now - lastAttempt < 12000) {
            return;
        }
        setBoundedMapValue(autoCaptureAttempts, attemptKey, now, MAX_AUTOCAPTURE_KEYS);

        const run = () => {
            if (
                !currentAdapter ||
                calibrationState !== 'idle' ||
                isConversationReadyForActions(conversationId, { includeDegraded: true })
            ) {
                return;
            }
            if (!rememberedPreferredStep) {
                return;
            }
            logger.info('Auto calibration run from remembered strategy', {
                platform: currentAdapter.name,
                conversationId,
                preferredStep: rememberedPreferredStep,
                reason,
            });
            void runCalibrationCapture('auto', conversationId);
        };

        if (rememberedPreferredStep || calibrationPreferenceLoaded) {
            run();
        } else {
            void ensureCalibrationPreferenceLoaded(currentAdapter.name).then(run);
        }
    }

    function handleResponseFinished(source: 'network' | 'dom', hintedConversationId?: string): void {
        const conversationId = resolveActiveConversationId(hintedConversationId);
        if (!shouldProcessFinishedSignal(conversationId, source)) {
            return;
        }
        const attemptId = resolveAttemptId(conversationId ?? undefined);
        activeAttemptId = attemptId;
        ingestSfeLifecycle('completed_hint', attemptId, conversationId);

        if (conversationId) {
            currentConversationId = conversationId;
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
            // When the SSE stream didn't deliver a "completed" lifecycle phase
            // (e.g. tab was backgrounded and stream reader stalled), the DOM
            // completion watcher is the only signal. In that case there may be
            // no cached data yet. Trigger a stream-done probe to capture it.
            const cached = interceptionManager.getConversation(conversationId);
            if (!cached || !evaluateReadinessForData(cached).ready) {
                setLifecycleState('completed', conversationId);
                void runStreamDoneProbe(conversationId, attemptId);
            }
            refreshButtonState(conversationId);
            scheduleButtonRefresh(conversationId);
            maybeRunAutoCapture(conversationId, 'response-finished');
        }
    }

    function registerCompletionWatcher(): () => void {
        if (currentAdapter?.name !== 'ChatGPT') {
            return () => {};
        }

        let wasGenerating = isChatGPTGenerating();

        const checkGenerationTransition = () => {
            const generating = isChatGPTGenerating();
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

    function handleTitleResolvedMessage(message: any): boolean {
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

        // Store the latest stream-derived title for this conversation
        streamResolvedTitles.set(conversationId, title);

        // Also update any already-cached conversation data in-place
        const cached = interceptionManager.getConversation(conversationId);
        if (cached) {
            cached.title = title;
        }

        logger.info('Title resolved from stream', { conversationId, title });
        return true;
    }

    function handleResponseFinishedMessage(message: any): boolean {
        if (
            (message as ResponseFinishedMessage | undefined)?.type !== 'BLACKIYA_RESPONSE_FINISHED' ||
            typeof (message as ResponseFinishedMessage).attemptId !== 'string'
        ) {
            return false;
        }
        const typed = message as ResponseFinishedMessage;
        const hintedConversationId = typeof message.conversationId === 'string' ? message.conversationId : undefined;
        const attemptId = resolveAliasedAttemptId(typed.attemptId);
        if (isStaleAttemptMessage(attemptId, hintedConversationId, 'finished')) {
            return true;
        }
        activeAttemptId = attemptId;
        if (hintedConversationId) {
            bindAttempt(hintedConversationId, attemptId);
        }
        // BLACKIYA_RESPONSE_FINISHED is an authoritative completion signal, but
        // during thinking/reasoning phases the interceptor emits these for every
        // stream_status poll. If the platform DOM still shows a generation
        // indicator (e.g. stop button), the signal is spurious — promoting
        // lifecycleState to 'completed' would corrupt the streaming guard and
        // cause the save button to flicker.
        if (lifecycleState === 'prompt-sent' || lifecycleState === 'streaming') {
            if (currentAdapter && isPlatformGenerating(currentAdapter)) {
                // #region agent log
                logger.info('RESPONSE_FINISHED rejected: platform still generating', {
                    conversationId: hintedConversationId ?? null,
                    attemptId,
                    lifecycleState,
                });
                // #endregion
                return true;
            }
            // #region agent log
            logger.info('RESPONSE_FINISHED promoted lifecycle to completed', {
                conversationId: hintedConversationId ?? null,
                attemptId,
                previousLifecycle: lifecycleState,
            });
            // #endregion
            lifecycleState = 'completed';
        }
        handleResponseFinished('network', hintedConversationId);
        return true;
    }

    function handleLifecycleMessage(message: any): boolean {
        if (
            (message as ResponseLifecycleMessage | undefined)?.type !== 'BLACKIYA_RESPONSE_LIFECYCLE' ||
            typeof (message as ResponseLifecycleMessage).attemptId !== 'string'
        ) {
            return false;
        }

        const typed = message as ResponseLifecycleMessage;
        const phase = typed.phase;
        const platform = typed.platform;
        const conversationId = typeof typed.conversationId === 'string' ? typed.conversationId : undefined;
        const attemptId = resolveAliasedAttemptId(typed.attemptId);

        if (phase === 'prompt-sent' && conversationId) {
            bindAttempt(conversationId, attemptId);
        }

        if (isStaleAttemptMessage(attemptId, conversationId, 'lifecycle')) {
            return true;
        }

        if (conversationId) {
            currentConversationId = conversationId;
            bindAttempt(conversationId, attemptId);
        }
        activeAttemptId = attemptId;

        if (phase !== 'prompt-sent' && phase !== 'streaming' && phase !== 'completed' && phase !== 'terminated') {
            return true;
        }

        logger.info('Lifecycle phase', {
            platform,
            phase,
            attemptId,
            conversationId: conversationId ?? null,
        });

        if (phase === 'prompt-sent') {
            ingestSfeLifecycle('prompt_sent', attemptId, conversationId ?? null);
        } else if (phase === 'streaming') {
            ingestSfeLifecycle('streaming', attemptId, conversationId ?? null);
        } else if (phase === 'completed') {
            ingestSfeLifecycle('completed_hint', attemptId, conversationId ?? null);
        } else if (phase === 'terminated') {
            ingestSfeLifecycle('terminated_partial', attemptId, conversationId ?? null);
        }

        if ((phase === 'prompt-sent' || phase === 'streaming') && conversationId) {
            if (!liveStreamPreviewByConversation.has(conversationId)) {
                setBoundedMapValue(liveStreamPreviewByConversation, conversationId, '', MAX_STREAM_PREVIEWS);
                setStreamProbePanel('stream: awaiting delta', `conversationId=${conversationId}`);
            }
        }

        if (phase === 'completed') {
            setLifecycleState('completed', conversationId);
            if (conversationId) {
                if (sfeEnabled) {
                    const resolution = sfe.resolve(attemptId);
                    const captureMeta = getCaptureMeta(conversationId);
                    const shouldRetryAfterCompletion =
                        !resolution.blockingConditions.includes('stabilization_timeout') &&
                        !resolution.ready &&
                        (resolution.phase === 'canonical_probing' || !shouldIngestAsCanonicalSample(captureMeta));
                    if (shouldRetryAfterCompletion) {
                        scheduleCanonicalStabilizationRetry(conversationId, attemptId);
                    }
                }
                void runStreamDoneProbe(conversationId, attemptId);
            }
        } else if (phase === 'prompt-sent' || phase === 'streaming') {
            setLifecycleState(phase, conversationId);
        }

        return true;
    }

    function handleStreamDeltaMessage(message: any): boolean {
        if (
            (message as StreamDeltaMessage | undefined)?.type !== 'BLACKIYA_STREAM_DELTA' ||
            typeof (message as StreamDeltaMessage).attemptId !== 'string'
        ) {
            return false;
        }
        if ((message as StreamDeltaMessage).platform !== 'ChatGPT') {
            return false;
        }

        const text = typeof message.text === 'string' ? message.text : '';
        if (text.length === 0) {
            return true;
        }

        const conversationId =
            typeof message.conversationId === 'string' && message.conversationId.length > 0
                ? message.conversationId
                : currentConversationId;
        const typed = message as StreamDeltaMessage;
        const attemptId = resolveAliasedAttemptId(typed.attemptId);
        if (isStaleAttemptMessage(attemptId, conversationId ?? undefined, 'delta')) {
            return true;
        }

        if (!conversationId) {
            return true;
        }

        activeAttemptId = attemptId;
        bindAttempt(conversationId, attemptId);
        appendLiveStreamProbeText(conversationId, text);
        return true;
    }

    function handleStreamDumpFrameMessage(message: any): boolean {
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

    function handleConversationIdResolvedMessage(message: any): boolean {
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

        activeAttemptId = canonicalAttemptId;
        bindAttempt(typed.conversationId, canonicalAttemptId);
        sfe.getAttemptTracker().updateConversationId(canonicalAttemptId, typed.conversationId);
        return true;
    }

    function handleAttemptDisposedMessage(message: any): boolean {
        if ((message as AttemptDisposedMessage | undefined)?.type !== 'BLACKIYA_ATTEMPT_DISPOSED') {
            return false;
        }
        const typed = message as AttemptDisposedMessage;
        if (typeof typed.attemptId !== 'string') {
            return false;
        }
        const attemptId = resolveAliasedAttemptId(typed.attemptId);
        cancelStreamDoneProbe(attemptId, typed.reason === 'superseded' ? 'superseded' : 'disposed');
        clearCanonicalStabilizationRetry(attemptId);
        sfe.dispose(attemptId);
        for (const [conversationId, attemptId] of attemptByConversation.entries()) {
            if (attemptId === typed.attemptId || attemptId === resolveAliasedAttemptId(typed.attemptId)) {
                attemptByConversation.delete(conversationId);
            }
        }
        if (activeAttemptId === attemptId || activeAttemptId === typed.attemptId) {
            activeAttemptId = null;
        }
        return true;
    }

    function postWindowBridgeResponse(
        requestId: string,
        success: boolean,
        options?: { data?: unknown; error?: string },
    ): void {
        window.postMessage(
            {
                type: 'BLACKIYA_GET_JSON_RESPONSE',
                requestId,
                success,
                data: options?.data,
                error: options?.error,
            },
            window.location.origin,
        );
    }

    function handleJsonBridgeRequest(message: any): void {
        if (message?.type !== 'BLACKIYA_GET_JSON_REQUEST') {
            return;
        }

        if (typeof message.requestId !== 'string') {
            return;
        }

        const requestId = message.requestId;
        const requestFormat = message.format === 'common' ? 'common' : 'original';
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

    function registerWindowBridge(): () => void {
        const handler = (event: MessageEvent) => {
            if (!isSameWindowOrigin(event)) {
                return;
            }

            const message = event.data;
            if (handleAttemptDisposedMessage(message)) {
                return;
            }
            if (handleConversationIdResolvedMessage(message)) {
                return;
            }
            if (handleStreamDeltaMessage(message)) {
                return;
            }
            if (handleStreamDumpFrameMessage(message)) {
                return;
            }
            if (handleTitleResolvedMessage(message)) {
                return;
            }
            if (handleLifecycleMessage(message)) {
                return;
            }
            if (handleResponseFinishedMessage(message)) {
                return;
            }
            handleJsonBridgeRequest(message);
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }

    function registerButtonHealthCheck(): () => void {
        const intervalId = window.setInterval(() => {
            if (!currentAdapter) {
                return;
            }

            const activeConversationId =
                currentAdapter.extractConversationId(window.location.href) || currentConversationId;
            if (!activeConversationId) {
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
        });
    }

    // -- Boot Sequence --

    const url = window.location.href;
    currentAdapter = getPlatformAdapter(url);

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
        if (changes[STORAGE_KEYS.PROBE_LEASE_ENABLED]) {
            probeLeaseEnabled = changes[STORAGE_KEYS.PROBE_LEASE_ENABLED]?.newValue === true;
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

    // Initial injection
    currentConversationId = currentAdapter.extractConversationId(url);
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

    // Cleanup on unload
    window.addEventListener('beforeunload', () => {
        try {
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
            for (const timerId of probeLeaseRetryTimers.values()) {
                clearTimeout(timerId);
            }
            probeLeaseRetryTimers.clear();
            probeLease.dispose();
            for (const timeoutId of retryTimeoutIds) {
                clearTimeout(timeoutId);
            }
            retryTimeoutIds.length = 0;
            autoCaptureDeferredLogged.clear();
        } catch (error) {
            logger.debug('Error during cleanup:', error);
        }
    });
}
