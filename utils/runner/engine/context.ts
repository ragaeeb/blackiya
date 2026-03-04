/**
 * Deps-builder factories for the platform runner engine.
 *
 * Engine types/constants and standalone utility wrappers live in dedicated
 * modules to keep this file focused on wiring.
 */

import { logger } from '@/utils/logger';
import type { AttemptCoordinatorDeps } from '@/utils/runner/attempt-coordinator';
import { shouldRemoveDisposedAttemptBinding as shouldRemoveDisposedAttemptBindingFromRegistry } from '@/utils/runner/attempt-state';
import type { ButtonStateManagerDeps } from '@/utils/runner/button-state-manager';
import { type CalibrationCaptureDeps, isConversationDataLike } from '@/utils/runner/calibration-capture';
import type { CanonicalStabilizationTickDeps } from '@/utils/runner/canonical-stabilization-tick';
import { buildIsolatedDomSnapshot } from '@/utils/runner/dom-snapshot';
import {
    emitStreamDumpConfig,
    evaluateReadinessForData,
    extractConversationIdFromLocation,
    getCaptureMeta,
    ingestStabilizationRetrySnapshot,
    isPlatformGenerating,
    resolveConversationIdForUserAction,
    resolveIsolatedSnapshotData,
    shouldBlockActionsForGeneration,
} from '@/utils/runner/engine/core-utils';
import { ingestSfeCanonicalSample, logSfeMismatchIfNeeded } from '@/utils/runner/engine/sfe-wrappers';
import {
    CANONICAL_READY_LOG_TTL_MS,
    CANONICAL_STABILIZATION_MAX_RETRIES,
    CANONICAL_STABILIZATION_RETRY_DELAY_MS,
    CANONICAL_STABILIZATION_TIMEOUT_GRACE_MS,
    type EngineCtx,
    MAX_AUTOCAPTURE_KEYS,
    MAX_CONVERSATION_ATTEMPTS,
    MAX_PENDING_LIFECYCLE_ATTEMPTS,
    MAX_STREAM_RESOLVED_TITLES,
    PROBE_LEASE_RETRY_GRACE_MS,
    PROBE_LEASE_TTL_MS,
} from '@/utils/runner/engine/types';
import { extractResponseTextFromConversation } from '@/utils/runner/export-helpers';
import type { InterceptionCaptureDeps } from '@/utils/runner/interception-capture';
import { requestPageSnapshot } from '@/utils/runner/page-snapshot-bridge';
import type { ResponseFinishedDeps } from '@/utils/runner/response-finished-handler';
import type { CalibrationRuntimeDeps } from '@/utils/runner/runtime/platform-runtime-calibration';
import type { RuntimeWiringDeps } from '@/utils/runner/runtime/platform-runtime-wiring';
import type { RunnerCleanupDeps } from '@/utils/runner/runtime/runtime-cleanup';
import type {
    StorageChangeListenerDeps,
    StreamDumpSettingDeps,
    StreamProbeVisibilitySettingDeps,
    VisibilityRecoveryDeps,
} from '@/utils/runner/runtime/runtime-settings';
import type { SavePipelineDeps } from '@/utils/runner/save-pipeline';
import { removeStreamProbePanel } from '@/utils/runner/stream/probe-panel';
import type { StreamDoneCoordinatorDeps } from '@/utils/runner/stream/stream-done-coordinator';
import { runStreamDoneProbe as runStreamDoneProbeReal } from '@/utils/runner/stream/stream-done-probe';
import { getFetchUrlCandidates, getRawSnapshotReplayUrls } from '@/utils/runner/url-candidates';
import type { WarmFetchDeps } from '@/utils/runner/warm-fetch';
import { shouldIngestAsCanonicalSample } from '@/utils/sfe/capture-fidelity';

export const buildAttemptCoordinatorDeps = (ctx: EngineCtx): AttemptCoordinatorDeps => ({
    maxConversationAttempts: MAX_CONVERSATION_ATTEMPTS,
    maxPendingLifecycleAttempts: MAX_PENDING_LIFECYCLE_ATTEMPTS,
    attemptByConversation: ctx.attemptByConversation,
    attemptAliasForward: ctx.attemptAliasForward,
    pendingLifecycleByAttempt: ctx.pendingLifecycleByAttempt,
    captureMetaByConversation: ctx.captureMetaByConversation,
    getCurrentConversationId: () => ctx.currentConversationId,
    setCurrentConversationId: (cid) => {
        ctx.currentConversationId = cid;
    },
    getActiveAttemptId: () => ctx.activeAttemptId,
    setActiveAttemptId: (aid) => {
        ctx.activeAttemptId = aid;
    },
    setRunnerConversationId: (cid) => {
        ctx.runnerState.conversationId = cid;
    },
    setRunnerActiveAttemptId: (aid) => {
        ctx.runnerState.activeAttemptId = aid;
    },
    getAdapterName: () => ctx.currentAdapter?.name,
    sfe: ctx.sfe,
    cancelStreamDoneProbe: (aid, reason) => ctx.cancelStreamDoneProbe(aid, reason),
    clearCanonicalStabilizationRetry: (aid) => ctx.clearCanonicalStabilizationRetry(aid),
    clearProbeLeaseRetry: (aid) => ctx.clearProbeLeaseRetry(aid),
    emitAttemptDisposed: (aid, reason) => ctx.emitAttemptDisposed(aid, reason),
    migratePendingStreamProbeText: (cid, aid) => ctx.migratePendingStreamProbeText(cid, aid),
    structuredLogger: ctx.structuredLogger,
    emitWarn: (message, data) => {
        logger.warn(message, data);
    },
    lastPendingLifecycleCapacityWarnAtRef: {
        get value() {
            return ctx.lastPendingLifecycleCapacityWarnAt;
        },
        set value(next: number) {
            ctx.lastPendingLifecycleCapacityWarnAt = next;
        },
    },
});

export const buildInterceptionCaptureDeps = (ctx: EngineCtx): InterceptionCaptureDeps => ({
    getStreamResolvedTitle: (cid) => ctx.streamResolvedTitles.get(cid),
    setCurrentConversation: (cid) => ctx.setCurrentConversation(cid),
    setActiveAttempt: (aid) => ctx.setActiveAttempt(aid),
    bindAttempt: (cid, aid) => ctx.bindAttempt(cid, aid),
    peekAttemptId: (cid) => ctx.peekAttemptId(cid),
    resolveAttemptId: (cid) => ctx.resolveAttemptId(cid),
    resolveAliasedAttemptId: (aid) => ctx.resolveAliasedAttemptId(aid),
    evaluateReadinessForData: (data) => evaluateReadinessForData(ctx, data),
    resolveReadinessDecision: (cid) => ctx.resolveReadinessDecision(cid),
    markSnapshotCaptureMeta: (cid) => ctx.markSnapshotCaptureMeta(cid),
    markCanonicalCaptureMeta: (cid) => ctx.markCanonicalCaptureMeta(cid),
    ingestSfeCanonicalSample: (data, aid) => ingestSfeCanonicalSample(ctx, data, aid),
    maybeRestartCanonicalRecoveryAfterTimeout: (cid, aid) => ctx.maybeRestartCanonicalRecoveryAfterTimeout(cid, aid),
    scheduleCanonicalStabilizationRetry: (cid, aid) => ctx.scheduleCanonicalStabilizationRetry(cid, aid),
    refreshButtonState: (cid) => ctx.refreshButtonState(cid),
    handleResponseFinished: (source, hintedCid) => ctx.handleResponseFinished(source, hintedCid),
    getLifecycleState: () => ctx.lifecycleState,
    structuredLogger: ctx.structuredLogger,
});

export const buildStreamDoneCoordinatorDeps = (ctx: EngineCtx): StreamDoneCoordinatorDeps => ({
    runStreamDoneProbeCore: runStreamDoneProbeReal,
    probeLease: ctx.probeLease,
    probeLeaseTtlMs: PROBE_LEASE_TTL_MS,
    probeLeaseRetryGraceMs: PROBE_LEASE_RETRY_GRACE_MS,
    streamProbeControllers: ctx.streamProbeControllers,
    probeLeaseRetryTimers: ctx.probeLeaseRetryTimers,
    attemptByConversation: ctx.attemptByConversation,
    resolveAliasedAttemptId: (aid) => ctx.resolveAliasedAttemptId(aid),
    isAttemptDisposedOrSuperseded: (aid) => ctx.isAttemptDisposedOrSuperseded(aid),
    structuredLogger: ctx.structuredLogger,
    setStreamProbePanel: (s, b) => ctx.setStreamProbePanel(s, b),
    withPreservedLiveMirrorSnapshot: (cid, s, b) => ctx.withPreservedLiveMirrorSnapshot(cid, s, b),
    resolveAttemptId: (cid) => ctx.resolveAttemptId(cid),
    getCurrentAdapter: () => ctx.currentAdapter,
    getFetchUrlCandidates: (cid) => (ctx.currentAdapter ? getFetchUrlCandidates(ctx.currentAdapter, cid) : []),
    getRawSnapshotReplayUrls: (cid, snap) =>
        ctx.currentAdapter ? getRawSnapshotReplayUrls(ctx.currentAdapter, cid, snap) : [snap.url],
    getConversation: (cid) => ctx.interceptionManager.getConversation(cid) ?? null,
    evaluateReadiness: (data) => evaluateReadinessForData(ctx, data),
    ingestConversationData: (data, source) => ctx.interceptionManager.ingestConversationData(data, source),
    ingestInterceptedData: (args) => ctx.interceptionManager.ingestInterceptedData(args),
    requestSnapshot: requestPageSnapshot,
    buildIsolatedSnapshot: (cid) => resolveIsolatedSnapshotData(ctx, cid),
    extractResponseText: (data) => extractResponseTextFromConversation(data, ctx.currentAdapter?.name ?? 'Unknown'),
    setLastProbeKey: (key, cid) => {
        ctx.lastStreamProbeKey = key;
        ctx.lastStreamProbeConversationId = cid;
    },
    isProbeKeyActive: (key) => ctx.lastStreamProbeKey === key,
});

export const buildCanonicalStabilizationTickDeps = (ctx: EngineCtx): CanonicalStabilizationTickDeps => ({
    maxRetries: CANONICAL_STABILIZATION_MAX_RETRIES,
    retryDelayMs: CANONICAL_STABILIZATION_RETRY_DELAY_MS,
    timeoutGraceMs: CANONICAL_STABILIZATION_TIMEOUT_GRACE_MS,
    retryTimers: ctx.canonicalStabilizationRetryTimers,
    retryCounts: ctx.canonicalStabilizationRetryCounts,
    startedAt: ctx.canonicalStabilizationStartedAt,
    timeoutWarnings: ctx.timeoutWarningByAttempt,
    inProgress: ctx.canonicalStabilizationInProgress,
    attemptByConversation: ctx.attemptByConversation,
    isAttemptDisposedOrSuperseded: (aid) => ctx.isAttemptDisposedOrSuperseded(aid),
    resolveAliasedAttemptId: (aid) => ctx.resolveAliasedAttemptId(aid),
    getSfePhase: (id) => ctx.sfe.resolve(id).phase,
    sfeRestartCanonicalRecovery: (id, now) => !!ctx.sfe.restartCanonicalRecovery(id, now),
    warmFetch: (cid) => ctx.warmFetchConversationSnapshot(cid, 'stabilization-retry'),
    requestSnapshot: requestPageSnapshot,
    buildIsolatedSnapshot: (cid) => resolveIsolatedSnapshotData(ctx, cid),
    ingestSnapshot: (cid, data) => ingestStabilizationRetrySnapshot(ctx, cid, data),
    getConversation: (cid) => ctx.interceptionManager.getConversation(cid) ?? null,
    evaluateReadiness: (data) => evaluateReadinessForData(ctx, data),
    getCaptureMeta: (cid) => getCaptureMeta(ctx, cid),
    ingestSfeCanonicalSample: (data, aid) => ingestSfeCanonicalSample(ctx, data, aid),
    markCanonicalCaptureMeta: (cid) => ctx.markCanonicalCaptureMeta(cid),
    refreshButtonState: (cid) => ctx.refreshButtonState(cid),
    emitWarn: (attemptId, event, message, payload, key) =>
        ctx.structuredLogger.emit(attemptId, 'warn', event, message, payload, key),
    emitDebug: (attemptId, event, message, payload, key) =>
        ctx.structuredLogger.emit(attemptId, 'debug', event, message, payload, key),
    emitInfo: (attemptId, event, message, payload, key) =>
        ctx.structuredLogger.emit(attemptId, 'info', event, message, payload, key),
});

export const buildSavePipelineDeps = (ctx: EngineCtx): SavePipelineDeps => ({
    getAdapter: () => ctx.currentAdapter,
    resolveConversationIdForUserAction: () => resolveConversationIdForUserAction(ctx),
    getConversation: (cid) => ctx.interceptionManager.getConversation(cid),
    resolveReadinessDecision: (cid) => ctx.resolveReadinessDecision(cid),
    shouldBlockActionsForGeneration: (cid) => shouldBlockActionsForGeneration(ctx, cid),
    getCaptureMeta: (cid) => getCaptureMeta(ctx, cid),
    getExportFormat: () => ctx.getExportFormat(),
    getStreamResolvedTitle: (cid) => ctx.streamResolvedTitles.get(cid) ?? null,
    evaluateReadinessForData: (data) => evaluateReadinessForData(ctx, data),
    markCanonicalCaptureMeta: (cid) => ctx.markCanonicalCaptureMeta(cid),
    ingestSfeCanonicalSample: (data, aid) => ingestSfeCanonicalSample(ctx, data, aid),
    resolveAttemptId: (cid) => ctx.resolveAttemptId(cid),
    peekAttemptId: (cid) => ctx.peekAttemptId(cid),
    refreshButtonState: (cid) => ctx.refreshButtonState(cid),
    requestPageSnapshot,
    warmFetchConversationSnapshot: (cid, reason) => ctx.warmFetchConversationSnapshot(cid, reason),
    ingestConversationData: (data, source) => ctx.interceptionManager.ingestConversationData(data, source),
    isConversationDataLike,
    buttonManagerExists: () => ctx.buttonManager.exists(),
    buttonManagerSetLoading: (loading, button) => ctx.buttonManager.setLoading(loading, button),
    buttonManagerSetSuccess: (button) => ctx.buttonManager.setSuccess(button),
    structuredLogger: ctx.structuredLogger,
});

export const buildWarmFetchDeps = (ctx: EngineCtx): WarmFetchDeps => ({
    platformName: ctx.currentAdapter?.name ?? 'Unknown',
    getFetchUrlCandidates: (cid) => (ctx.currentAdapter ? getFetchUrlCandidates(ctx.currentAdapter, cid) : []),
    ingestInterceptedData: (args) => ctx.interceptionManager.ingestInterceptedData(args),
    getConversation: (cid) => ctx.interceptionManager.getConversation(cid) ?? null,
    evaluateReadiness: (data) => evaluateReadinessForData(ctx, data),
    getCaptureMeta: (cid) => getCaptureMeta(ctx, cid),
});

export const buildCalibrationCaptureDeps = (ctx: EngineCtx, _conversationId: string): CalibrationCaptureDeps => ({
    adapter: ctx.currentAdapter!,
    isCaptureSatisfied: (cid, mode) => ctx.isCalibrationCaptureSatisfied(cid, mode),
    flushQueuedMessages: () => ctx.interceptionManager.flushQueuedMessages(),
    requestSnapshot: (cid) => requestPageSnapshot(cid),
    buildIsolatedSnapshot: (cid) => (ctx.currentAdapter ? buildIsolatedDomSnapshot(ctx.currentAdapter, cid) : null),
    ingestConversationData: (data, source) => ctx.interceptionManager.ingestConversationData(data, source),
    ingestInterceptedData: (args) => ctx.interceptionManager.ingestInterceptedData(args),
    getFetchUrlCandidates: (cid) => (ctx.currentAdapter ? getFetchUrlCandidates(ctx.currentAdapter, cid) : []),
    getRawSnapshotReplayUrls: (cid, snap) =>
        ctx.currentAdapter ? getRawSnapshotReplayUrls(ctx.currentAdapter, cid, snap) : [snap.url],
});

export const buildCalibrationRuntimeDeps = (ctx: EngineCtx): CalibrationRuntimeDeps => ({
    getAdapter: () => ctx.currentAdapter,
    getCalibrationState: () => ctx.calibrationState,
    setCalibrationState: (state) => {
        ctx.calibrationState = state;
    },
    getRememberedPreferredStep: () => ctx.rememberedPreferredStep,
    setRememberedPreferredStep: (step) => {
        ctx.rememberedPreferredStep = step;
    },
    getRememberedCalibrationUpdatedAt: () => ctx.rememberedCalibrationUpdatedAt,
    setRememberedCalibrationUpdatedAt: (at) => {
        ctx.rememberedCalibrationUpdatedAt = at;
    },
    isCalibrationPreferenceLoaded: () => ctx.calibrationPreferenceLoaded,
    setCalibrationPreferenceLoaded: (loaded) => {
        ctx.calibrationPreferenceLoaded = loaded;
    },
    getCalibrationPreferenceLoading: () => ctx.calibrationPreferenceLoading,
    setCalibrationPreferenceLoading: (promise) => {
        ctx.calibrationPreferenceLoading = promise;
    },
    getSfeEnabled: () => ctx.sfeEnabled,
    setSfeEnabled: (enabled) => {
        ctx.sfeEnabled = enabled;
    },
    runCalibrationStep: (step, cid, mode) => ctx.runCalibrationStep(step, cid, mode),
    isConversationReadyForActions: (cid, opts) => ctx.isConversationReadyForActions(cid, opts),
    hasConversationData: (cid) => !!ctx.interceptionManager.getConversation(cid),
    refreshButtonState: (cid) => ctx.refreshButtonState(cid),
    buttonManagerExists: () => ctx.buttonManager.exists(),
    buttonManagerSetCalibrationState: (state, options) => ctx.buttonManager.setCalibrationState(state, options),
    syncRunnerStateCalibration: (state) => {
        ctx.runnerState.calibrationState = state;
    },
    autoCaptureAttempts: ctx.autoCaptureAttempts,
    autoCaptureRetryTimers: ctx.autoCaptureRetryTimers,
    autoCaptureDeferredLogged: ctx.autoCaptureDeferredLogged,
    maxAutocaptureKeys: MAX_AUTOCAPTURE_KEYS,
    peekAttemptId: (cid) => ctx.peekAttemptId(cid),
    resolveAttemptId: (cid) => ctx.resolveAttemptId(cid),
    warmFetchInFlight: ctx.warmFetchInFlight,
    buildWarmFetchDeps: () => buildWarmFetchDeps(ctx),
    buildCalibrationCaptureDeps: (cid) => buildCalibrationCaptureDeps(ctx, cid),
});

export const buildButtonStateManagerDeps = (ctx: EngineCtx): ButtonStateManagerDeps => ({
    getAdapter: () => ctx.currentAdapter,
    getCurrentConversationId: () => ctx.currentConversationId,
    getLifecycleState: () => ctx.lifecycleState,
    getCalibrationState: () => ctx.calibrationState,
    setCalibrationState: (state) => {
        ctx.calibrationState = state;
    },
    getRememberedPreferredStep: () => ctx.rememberedPreferredStep,
    getRememberedCalibrationUpdatedAt: () => ctx.rememberedCalibrationUpdatedAt,
    sfeEnabled: () => ctx.sfeEnabled,
    sfe: ctx.sfe,
    attemptByConversation: ctx.attemptByConversation,
    captureMetaByConversation: ctx.captureMetaByConversation,
    lastCanonicalReadyLogAtByConversation: ctx.lastCanonicalReadyLogAtByConversation,
    timeoutWarningByAttempt: ctx.timeoutWarningByAttempt,
    maxConversationAttempts: MAX_CONVERSATION_ATTEMPTS,
    maxAutocaptureKeys: MAX_AUTOCAPTURE_KEYS,
    canonicalReadyLogTtlMs: CANONICAL_READY_LOG_TTL_MS,
    getConversation: (cid) => ctx.interceptionManager.getConversation(cid),
    evaluateReadinessForData: (data) => evaluateReadinessForData(ctx, data),
    peekAttemptId: (cid) => ctx.peekAttemptId(cid),
    hasCanonicalStabilizationTimedOut: (aid) => ctx.hasCanonicalStabilizationTimedOut(aid),
    logSfeMismatchIfNeeded: (cid, ready) => logSfeMismatchIfNeeded(ctx, cid, ready),
    ingestSfeCanonicalSample: (data, aid) => ingestSfeCanonicalSample(ctx, data, aid),
    isLifecycleActiveGeneration: () => ctx.isLifecycleActiveGeneration(),
    shouldBlockActionsForGeneration: (cid) => shouldBlockActionsForGeneration(ctx, cid),
    setCurrentConversation: (cid) => ctx.setCurrentConversation(cid),
    setLifecycleState: (state, cid) => ctx.setLifecycleState(state, cid),
    syncCalibrationButtonDisplay: () => ctx.syncCalibrationButtonDisplay(),
    syncRunnerStateCalibration: (state) => {
        ctx.runnerState.calibrationState = state;
    },
    emitExternalConversationEvent: (args) => ctx.emitExternalConversationEvent(args),
    buttonManager: {
        exists: () => ctx.buttonManager.exists(),
        inject: (target, cid) => ctx.buttonManager.inject(target, cid),
        setLifecycleState: (state) => ctx.buttonManager.setLifecycleState(state),
        setCalibrationState: (state, options) => ctx.buttonManager.setCalibrationState(state, options),
        setSaveButtonMode: (mode) => ctx.buttonManager.setSaveButtonMode(mode),
        setActionButtonsEnabled: (enabled) => ctx.buttonManager.setActionButtonsEnabled(enabled),
        setOpacity: (opacity) => ctx.buttonManager.setOpacity(opacity),
        setButtonEnabled: (button, enabled) => ctx.buttonManager.setButtonEnabled(button, enabled),
        setReadinessSource: (source) => ctx.buttonManager.setReadinessSource(source),
    },
    structuredLogger: ctx.structuredLogger,
});

export const buildResponseFinishedDeps = (ctx: EngineCtx): ResponseFinishedDeps => ({
    extractConversationIdFromUrl: () =>
        ctx.currentAdapter ? ctx.currentAdapter.extractConversationId(window.location.href) : null,
    getCurrentConversationId: () => ctx.currentConversationId,
    peekAttemptId: (cid) => ctx.peekAttemptId(cid),
    resolveAttemptId: (cid) => ctx.resolveAttemptId(cid),
    setActiveAttempt: (aid) => ctx.setActiveAttempt(aid),
    setCurrentConversation: (cid) => ctx.setCurrentConversation(cid),
    bindAttempt: (cid, aid) => ctx.bindAttempt(cid, aid),
    ingestSfeLifecycle: (phase, aid, cid) => ctx.ingestSfeLifecycle(phase, aid, cid),
    getCalibrationState: () => ctx.calibrationState,
    shouldBlockActionsForGeneration: (cid) => shouldBlockActionsForGeneration(ctx, cid),
    adapterName: () => ctx.currentAdapter?.name ?? null,
    getLastResponseFinished: () => ({
        at: ctx.lastResponseFinishedAt,
        conversationId: ctx.lastResponseFinishedConversationId,
        attemptId: ctx.lastResponseFinishedAttemptId,
    }),
    setLastResponseFinished: (at, cid, aid) => {
        ctx.lastResponseFinishedAt = at;
        ctx.lastResponseFinishedConversationId = cid;
        if (aid) {
            ctx.lastResponseFinishedAttemptId = aid;
        }
    },
    getConversation: (cid) => ctx.interceptionManager.getConversation(cid),
    evaluateReadiness: (data) => evaluateReadinessForData(ctx, data),
    getLifecycleState: () => ctx.lifecycleState,
    setCompletedLifecycleState: (cid, aid) => {
        ctx.lifecycleAttemptId = aid;
        ctx.lifecycleConversationId = cid;
        ctx.setLifecycleState('completed', cid);
    },
    runStreamDoneProbe: (cid, aid) => ctx.runStreamDoneProbe(cid, aid),
    refreshButtonState: (cid) => ctx.refreshButtonState(cid),
    scheduleButtonRefresh: (cid) => ctx.scheduleButtonRefresh(cid),
    maybeRunAutoCapture: (cid, reason) => ctx.maybeRunAutoCapture(cid, reason),
});

export const buildRuntimeWiringDeps = (ctx: EngineCtx): RuntimeWiringDeps => ({
    getAdapter: () => ctx.currentAdapter,
    getCurrentConversationId: () => ctx.currentConversationId,
    getActiveAttemptId: () => ctx.activeAttemptId,
    resolveAliasedAttemptId: (aid) => ctx.resolveAliasedAttemptId(aid),
    isStaleAttemptMessage: (aid, cid, st) => ctx.isStaleAttemptMessage(aid, cid, st),
    forwardAttemptAlias: (from, to, reason) => ctx.forwardAttemptAlias(from, to, reason),
    setActiveAttempt: (aid) => ctx.setActiveAttempt(aid),
    setCurrentConversation: (cid) => ctx.setCurrentConversation(cid),
    bindAttempt: (cid, aid) => {
        if (cid) {
            ctx.bindAttempt(cid, aid);
        }
    },
    getLifecycleState: () => ctx.lifecycleState,
    setLifecycleState: (state, cid) => ctx.setLifecycleState(state, cid),
    getLifecycleAttemptId: () => ctx.lifecycleAttemptId,
    setLifecycleAttemptId: (aid) => {
        ctx.lifecycleAttemptId = aid;
    },
    getLifecycleConversationId: () => ctx.lifecycleConversationId,
    setLifecycleConversationId: (cid) => {
        ctx.lifecycleConversationId = cid;
    },
    isPlatformGenerating: () => !!ctx.currentAdapter && isPlatformGenerating(ctx.currentAdapter),
    streamResolvedTitles: ctx.streamResolvedTitles,
    maxStreamResolvedTitles: MAX_STREAM_RESOLVED_TITLES,
    getConversation: (cid) => ctx.interceptionManager.getConversation(cid) ?? undefined,
    cachePendingLifecycleSignal: (aid, phase, platform) => ctx.cachePendingLifecycleSignal(aid, phase, platform),
    ingestSfeLifecycleFromWirePhase: (phase, aid, cid) => ctx.ingestSfeLifecycleFromWirePhase(phase, aid, cid),
    handleResponseFinished: (source, hintedCid) => ctx.handleResponseFinished(source, hintedCid),
    appendPendingStreamProbeText: (aid, text) => ctx.appendPendingStreamProbeText(aid, text),
    appendLiveStreamProbeText: (cid, text) => ctx.appendLiveStreamProbeText(cid, text),
    isStreamDumpEnabled: () => ctx.streamDumpEnabled,
    pendingLifecycleByAttempt: ctx.pendingLifecycleByAttempt,
    sfeUpdateConversationId: (aid, cid) => ctx.sfe.getAttemptTracker().updateConversationId(aid, cid),
    refreshButtonState: (cid) => ctx.refreshButtonState(cid),
    cancelStreamDoneProbe: (aid, reason) => ctx.cancelStreamDoneProbe(aid, reason),
    clearCanonicalStabilizationRetry: (aid) => ctx.clearCanonicalStabilizationRetry(aid),
    sfeDispose: (aid) => ctx.sfe.dispose(aid),
    streamPreviewState: ctx.streamPreviewState,
    attemptByConversation: ctx.attemptByConversation,
    shouldRemoveDisposedAttemptBinding: (mapped, disposed, resolve) =>
        shouldRemoveDisposedAttemptBindingFromRegistry(mapped, disposed, resolve),
    getCaptureMeta: (cid) => getCaptureMeta(ctx, cid),
    shouldIngestAsCanonicalSample,
    scheduleCanonicalStabilizationRetry: (cid, aid) => ctx.scheduleCanonicalStabilizationRetry(cid, aid),
    runStreamDoneProbe: (cid, aid) => {
        if (!cid) {
            return Promise.resolve();
        }
        return ctx.runStreamDoneProbe(cid, aid);
    },
    setStreamProbePanel: (s, b) => ctx.setStreamProbePanel(s, b),
    liveStreamPreviewByConversation: ctx.liveStreamPreviewByConversation,
    sfeEnabled: () => ctx.sfeEnabled,
    sfeResolve: (aid) => ctx.sfe.resolve(aid),
    getLastInvalidSessionTokenLogAt: () => ctx.lastInvalidSessionTokenLogAt,
    setLastInvalidSessionTokenLogAt: (value) => {
        ctx.lastInvalidSessionTokenLogAt = value;
    },
    extractConversationIdFromLocation: () => extractConversationIdFromLocation(ctx),
    buttonManagerExists: () => ctx.buttonManager.exists(),
    injectSaveButton: () => ctx.injectSaveButton(),
    isLifecycleActiveGeneration: () => ctx.isLifecycleActiveGeneration(),
    updateAdapter: (adapter) => {
        ctx.currentAdapter = adapter;
        ctx.runnerState.adapter = adapter;
        if (adapter) {
            ctx.interceptionManager.updateAdapter(adapter);
        }
    },
    buttonManagerRemove: () => ctx.buttonManager.remove(),
    resetCalibrationPreference: () => ctx.resetCalibrationPreference(),
    ensureCalibrationPreferenceLoaded: (platformName) => ctx.ensureCalibrationPreferenceLoaded(platformName),
    warmFetch: (cid, reason) => ctx.warmFetchConversationSnapshot(cid, reason),
    maybeRunAutoCapture: (cid, reason) => ctx.maybeRunAutoCapture(cid, reason),
    disposeInFlightAttemptsOnNavigation: (preserveConversationId) => {
        const disposedAttemptIds = ctx.sfe
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
            ctx.cancelStreamDoneProbe(attemptId, 'navigation');
            ctx.clearCanonicalStabilizationRetry(attemptId);
            ctx.clearProbeLeaseRetry(attemptId);
            ctx.emitAttemptDisposed(attemptId, 'navigation');
        }
    },
});

export const buildStreamDumpSettingDeps = (ctx: EngineCtx): StreamDumpSettingDeps => ({
    setStreamDumpEnabled: (enabled) => {
        ctx.streamDumpEnabled = enabled;
    },
    emitStreamDumpConfig: () => emitStreamDumpConfig(ctx),
});

export const buildStreamProbeVisibilitySettingDeps = (ctx: EngineCtx): StreamProbeVisibilitySettingDeps => ({
    setStreamProbeVisible: (visible) => {
        ctx.streamProbeVisible = visible;
    },
    getStreamProbeVisible: () => ctx.streamProbeVisible,
    removeStreamProbePanel,
});

export const buildStorageChangeListenerDeps = (ctx: EngineCtx): StorageChangeListenerDeps => ({
    setStreamDumpEnabled: (enabled) => {
        ctx.streamDumpEnabled = enabled;
    },
    emitStreamDumpConfig: () => emitStreamDumpConfig(ctx),
    setStreamProbeVisible: (visible) => {
        ctx.streamProbeVisible = visible;
    },
    removeStreamProbePanel,
    setSfeEnabled: (enabled) => {
        ctx.sfeEnabled = enabled;
    },
    refreshButtonState: (cid) => ctx.refreshButtonState(cid),
    getCurrentConversationId: () => ctx.currentConversationId,
    hasAdapter: () => !!ctx.currentAdapter,
    handleCalibrationProfilesChanged: () => ctx.handleCalibrationProfilesChanged(),
});

export const buildVisibilityRecoveryDeps = (ctx: EngineCtx): VisibilityRecoveryDeps => ({
    resolveConversationId: () => ctx.currentAdapter?.extractConversationId(window.location.href) ?? null,
    getCurrentConversationId: () => ctx.currentConversationId,
    resolveReadinessDecision: (cid) => ctx.resolveReadinessDecision(cid),
    resolveAttemptId: (cid) => ctx.resolveAttemptId(cid),
    maybeRestartCanonicalRecoveryAfterTimeout: (cid, aid) => ctx.maybeRestartCanonicalRecoveryAfterTimeout(cid, aid),
    requestPageSnapshot,
    isConversationDataLike,
    ingestConversationData: (data, source) => {
        ctx.interceptionManager.ingestConversationData(data, source);
    },
    getConversation: (cid) => ctx.interceptionManager.getConversation(cid),
    evaluateReadinessForData: (data) => evaluateReadinessForData(ctx, data),
    markCanonicalCaptureMeta: (cid) => ctx.markCanonicalCaptureMeta(cid),
    ingestSfeCanonicalSample: (data, aid) => ingestSfeCanonicalSample(ctx, data, aid),
    refreshButtonState: (cid) => ctx.refreshButtonState(cid),
    warmFetchConversationSnapshot: (cid, reason) => ctx.warmFetchConversationSnapshot(cid, reason),
});

export const buildCleanupRuntimeDeps = (
    ctx: EngineCtx,
    runnerControl: { cleanup?: () => void },
    storageChangeListener: Parameters<typeof import('wxt/browser').browser.storage.onChanged.addListener>[0],
): RunnerCleanupDeps => ({
    isCleanedUp: () => ctx.cleanedUp,
    markCleanedUp: () => {
        ctx.cleanedUp = true;
    },
    removeVisibilityChangeListener: () => {},
    disposeAllAttempts: () => ctx.sfe.disposeAll(),
    handleDisposedAttempt: (attemptId, reason) => {
        ctx.cancelStreamDoneProbe(attemptId, reason);
        ctx.clearCanonicalStabilizationRetry(attemptId);
        ctx.clearProbeLeaseRetry(attemptId);
        ctx.emitAttemptDisposed(attemptId, reason);
    },
    stopInterceptionManager: () => ctx.interceptionManager.stop(),
    stopNavigationManager: () => ctx.navigationManager.stop(),
    removeButtons: () => ctx.buttonManager.remove(),
    cleanupWindowBridge: ctx.cleanupWindowBridge,
    cleanupCompletionWatcher: ctx.cleanupCompletionWatcher,
    cleanupButtonHealthCheck: ctx.cleanupButtonHealthCheck,
    cleanupTabDebugRuntimeListener: ctx.cleanupTabDebugRuntimeListener,
    removeStorageChangeListener: () => {
        (async () => {
            const { browser } = await import('wxt/browser');
            browser.storage.onChanged.removeListener(storageChangeListener);
        })();
    },
    autoCaptureRetryTimers: ctx.autoCaptureRetryTimers,
    canonicalStabilizationRetryTimers: ctx.canonicalStabilizationRetryTimers,
    canonicalStabilizationRetryCounts: ctx.canonicalStabilizationRetryCounts,
    canonicalStabilizationStartedAt: ctx.canonicalStabilizationStartedAt,
    timeoutWarningByAttempt: ctx.timeoutWarningByAttempt,
    canonicalStabilizationInProgress: ctx.canonicalStabilizationInProgress,
    probeLeaseRetryTimers: ctx.probeLeaseRetryTimers,
    streamProbeControllers: ctx.streamProbeControllers,
    disposeProbeLease: () => ctx.probeLease.dispose(),
    retryTimeoutIds: ctx.retryTimeoutIds,
    autoCaptureDeferredLogged: ctx.autoCaptureDeferredLogged,
    beforeUnloadHandlerRef: {
        get value() {
            return ctx.beforeUnloadHandler;
        },
        set value(next: (() => void) | null) {
            ctx.beforeUnloadHandler = next;
        },
    },
    removeBeforeUnloadListener: (handler) => {
        window.removeEventListener('beforeunload', handler);
    },
    clearRunnerControl: () => {
        const RUNNER_CONTROL_KEY = '__BLACKIYA_RUNNER_CONTROL__';
        const globalControl = (window as unknown as Record<string, unknown>)[RUNNER_CONTROL_KEY] as
            | { cleanup?: () => void }
            | undefined;
        if (globalControl === runnerControl) {
            delete (window as unknown as Record<string, unknown>)[RUNNER_CONTROL_KEY];
        }
    },
});
