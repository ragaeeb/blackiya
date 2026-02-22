/**
 * Shared context type and deps-builder factories for the platform runner engine.
 *
 * The EngineCtx accumulates mutable state, service references, and function
 * references as the engine initialises. Deps builders read current values
 * from the context by reference, so they always see the latest state.
 */

import { browser } from 'wxt/browser';
import type { LLMPlatform } from '@/platforms/types';
import {
    buildExternalInternalEventMessage,
    maybeBuildExternalConversationEvent,
    type ExternalEventDispatcherState,
} from '@/utils/runner/external-event-dispatch';
import { logger } from '@/utils/logger';
import type { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import type { InterceptionManager } from '@/utils/managers/interception-manager';
import type { NavigationManager } from '@/utils/managers/navigation-manager';
import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import type {
    AttemptDisposedMessage,
    ResponseLifecycleMessage,
    StreamDumpConfigMessage,
} from '@/utils/protocol/messages';
import { stampToken } from '@/utils/protocol/session-token';
import { DEFAULT_EXPORT_FORMAT, type ExportFormat } from '@/utils/settings';
import { shouldIngestAsCanonicalSample } from '@/utils/sfe/capture-fidelity';
import type { CrossTabProbeLease } from '@/utils/sfe/cross-tab-probe-lease';
import type { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';
import type { ExportMeta, LifecyclePhase, PlatformReadiness, ReadinessDecision } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';
import type { ButtonManager } from '@/utils/ui/button-manager';
import type { AttemptCoordinatorDeps } from './attempt-coordinator';
import { shouldRemoveDisposedAttemptBinding as shouldRemoveDisposedAttemptBindingFromRegistry } from './attempt-state';
import type { AutoCaptureReason } from './auto-capture';
import type { ButtonStateManagerDeps } from './button-state-manager';
import { type CalibrationCaptureDeps, isConversationDataLike } from './calibration-capture';
import type { CalibrationOrchestrationDeps } from './calibration-orchestration';
import type { CalibrationMode } from './calibration-policy';
import type { CalibrationStep } from './calibration-runner';
import type { CanonicalStabilizationTickDeps } from './canonical-stabilization-tick';
import { buildIsolatedDomSnapshot } from './dom-snapshot';
import {
    buildExportPayloadForFormat as buildExportPayloadForFormatPure,
    extractResponseTextFromConversation,
} from './export-helpers';
import { detectPlatformGenerating } from './generation-guard';
import type { InterceptionCaptureDeps } from './interception-capture';
import { requestPageSnapshot } from './page-snapshot-bridge';
import type { CalibrationRuntimeDeps } from './platform-runtime-calibration';
import type { RuntimeWiringDeps } from './platform-runtime-wiring';
import { removeStreamProbePanel } from './probe-panel';
import { evaluateReadinessForData as evaluateReadinessForDataPure } from './readiness-evaluation';
import type { ResponseFinishedDeps } from './response-finished-handler';
import type { RunnerCleanupDeps } from './runtime-cleanup';
import type {
    StorageChangeListenerDeps,
    StreamDumpSettingDeps,
    StreamProbeVisibilitySettingDeps,
    VisibilityRecoveryDeps,
} from './runtime-settings';
import { getExportFormat as getExportFormatCore } from './runtime-settings';
import type { SavePipelineDeps } from './save-pipeline';
import type { SfeIngestionDeps } from './sfe-ingestion';
import {
    emitAttemptDisposed as emitAttemptDisposedCore,
    ingestSfeCanonicalSample as ingestSfeCanonicalSampleCore,
    ingestSfeLifecycleFromWirePhase as ingestSfeLifecycleFromWirePhaseCore,
    ingestSfeLifecycleSignal as ingestSfeLifecycleSignalCore,
    logSfeMismatchIfNeeded as logSfeMismatchIfNeededCore,
} from './sfe-ingestion';
import type { StaleAttemptFilterDeps } from './stale-attempt-filter';
import { isStaleAttemptMessage as isStaleAttemptMessageCore } from './stale-attempt-filter';
import type { RunnerState } from './state';
import type { StreamDoneCoordinatorDeps } from './stream-done-coordinator';
import { runStreamDoneProbe as runStreamDoneProbeReal } from './stream-done-probe';
import type { RunnerStreamPreviewState } from './stream-preview';
import { getFetchUrlCandidates, getRawSnapshotReplayUrls } from './url-candidates';
import type { WarmFetchDeps, WarmFetchReason } from './warm-fetch';

// ── Local types ──

export type LifecycleUiState = 'idle' | 'prompt-sent' | 'streaming' | 'completed';
export type CalibrationUiState = 'idle' | 'waiting' | 'capturing' | 'success' | 'error';

// ── Constants ──

export const CANONICAL_STABILIZATION_RETRY_DELAY_MS = 1150;
export const CANONICAL_STABILIZATION_MAX_RETRIES = 6;
export const CANONICAL_STABILIZATION_TIMEOUT_GRACE_MS = 400;
export const PROBE_LEASE_TTL_MS = 5000;
export const PROBE_LEASE_RETRY_GRACE_MS = 500;
export const MAX_CONVERSATION_ATTEMPTS = 250;
export const MAX_PENDING_LIFECYCLE_ATTEMPTS = 320;
export const MAX_STREAM_PREVIEWS = 150;
export const MAX_AUTOCAPTURE_KEYS = 400;
export const MAX_STREAM_RESOLVED_TITLES = MAX_CONVERSATION_ATTEMPTS;
export const CANONICAL_READY_LOG_TTL_MS = 15_000;

// ── Engine context ──

export type EngineCtx = {
    // Mutable scalar state
    currentAdapter: LLMPlatform | null;
    currentConversationId: string | null;
    lifecycleState: LifecycleUiState;
    lifecycleAttemptId: string | null;
    lifecycleConversationId: string | null;
    calibrationState: CalibrationUiState;
    activeAttemptId: string | null;
    sfeEnabled: boolean;
    streamDumpEnabled: boolean;
    streamProbeVisible: boolean;
    cleanedUp: boolean;
    lastResponseFinishedAt: number;
    lastResponseFinishedConversationId: string | null;
    lastResponseFinishedAttemptId: string | null;
    rememberedPreferredStep: CalibrationStep | null;
    rememberedCalibrationUpdatedAt: string | null;
    calibrationPreferenceLoaded: boolean;
    calibrationPreferenceLoading: Promise<void> | null;
    lastStreamProbeKey: string;
    lastStreamProbeConversationId: string | null;
    lastInvalidSessionTokenLogAt: number;
    lastPendingLifecycleCapacityWarnAt: number;
    beforeUnloadHandler: (() => void) | null;
    cleanupWindowBridge: (() => void) | null;
    cleanupCompletionWatcher: (() => void) | null;
    cleanupButtonHealthCheck: (() => void) | null;
    lastButtonStateLogRef: { value: string };

    // Collections
    attemptByConversation: Map<string, string>;
    attemptAliasForward: Map<string, string>;
    pendingLifecycleByAttempt: Map<
        string,
        { phase: ResponseLifecycleMessage['phase']; platform: string; receivedAtMs: number }
    >;
    captureMetaByConversation: Map<string, ExportMeta>;
    streamResolvedTitles: Map<string, string>;
    lastCanonicalReadyLogAtByConversation: Map<string, number>;
    timeoutWarningByAttempt: Set<string>;
    canonicalStabilizationRetryTimers: Map<string, number>;
    canonicalStabilizationRetryCounts: Map<string, number>;
    canonicalStabilizationStartedAt: Map<string, number>;
    canonicalStabilizationInProgress: Set<string>;
    streamProbeControllers: Map<string, AbortController>;
    probeLeaseRetryTimers: Map<string, number>;
    warmFetchInFlight: Map<string, Promise<boolean>>;
    autoCaptureAttempts: Map<string, number>;
    autoCaptureRetryTimers: Map<string, number>;
    autoCaptureDeferredLogged: Set<string>;
    retryTimeoutIds: number[];
    liveStreamPreviewByConversation: Map<string, string>;

    // Services
    sfe: SignalFusionEngine;
    probeLease: CrossTabProbeLease;
    structuredLogger: StructuredAttemptLogger;
    runnerState: RunnerState;
    interceptionManager: InterceptionManager;
    navigationManager: NavigationManager;
    buttonManager: ButtonManager;
    streamPreviewState: RunnerStreamPreviewState;
    externalEventDispatchState: ExternalEventDispatcherState;
    streamProbeRuntime: ReturnType<typeof import('./platform-runtime-stream-probe').createStreamProbeRuntime> | null;

    // Function refs (populated incrementally during init)
    setCurrentConversation: (cid: string | null) => void;
    setActiveAttempt: (aid: string | null) => void;
    bindAttempt: (cid: string | undefined, aid: string) => void;
    resolveAliasedAttemptId: (aid: string) => string;
    peekAttemptId: (cid?: string) => string | null;
    resolveAttemptId: (cid?: string) => string;
    isAttemptDisposedOrSuperseded: (aid: string) => boolean;
    forwardAttemptAlias: (from: string, to: string, reason: 'superseded' | 'rebound') => void;
    markSnapshotCaptureMeta: (cid: string) => void;
    markCanonicalCaptureMeta: (cid: string) => void;
    cachePendingLifecycleSignal: (
        attemptId: string,
        phase: ResponseLifecycleMessage['phase'],
        platform: string,
    ) => void;
    cancelStreamDoneProbe: (aid: string, reason: 'superseded' | 'disposed' | 'navigation' | 'teardown') => void;
    clearProbeLeaseRetry: (aid: string) => void;
    runStreamDoneProbe: (cid: string, aid?: string) => Promise<void>;
    clearCanonicalStabilizationRetry: (aid: string) => void;
    hasCanonicalStabilizationTimedOut: (aid: string) => boolean;
    scheduleCanonicalStabilizationRetry: (cid: string, aid: string) => void;
    maybeRestartCanonicalRecoveryAfterTimeout: (cid: string, aid: string) => void;
    ingestSfeLifecycle: (phase: LifecyclePhase, aid: string, cid?: string | null) => void;
    ingestSfeCanonicalSample: (
        data: ConversationData,
        aid?: string,
    ) => ReturnType<SignalFusionEngine['applyCanonicalSample']> | null;
    logSfeMismatchIfNeeded: (cid: string, legacyReady: boolean) => void;
    emitAttemptDisposed: (aid: string, reason: AttemptDisposedMessage['reason']) => void;
    evaluateReadinessForData: (data: ConversationData) => PlatformReadiness;
    refreshButtonState: (cid?: string) => void;
    scheduleButtonRefresh: (cid: string) => void;
    injectSaveButton: () => void;
    resolveReadinessDecision: (cid: string) => ReadinessDecision;
    isConversationReadyForActions: (cid: string, opts?: { includeDegraded?: boolean }) => boolean;
    shouldBlockActionsForGeneration: (cid: string) => boolean;
    isLifecycleActiveGeneration: () => boolean;
    setLifecycleState: (state: LifecycleUiState, cid?: string) => void;
    handleResponseFinished: (source: 'network' | 'dom', hintedCid?: string) => void;
    handleSaveClick: () => Promise<void>;
    handleCalibrationClick: () => Promise<void>;
    getConversationData: (opts?: { silent?: boolean; allowDegraded?: boolean }) => Promise<ConversationData | null>;
    warmFetchConversationSnapshot: (cid: string, reason: WarmFetchReason) => Promise<boolean>;
    maybeRunAutoCapture: (cid: string, reason: AutoCaptureReason) => void;
    syncCalibrationButtonDisplay: () => void;
    ensureCalibrationPreferenceLoaded: (platformName: string) => Promise<void>;
    isCalibrationCaptureSatisfied: (cid: string, mode: CalibrationMode) => boolean;
    resetCalibrationPreference: () => void;
    handleCalibrationProfilesChanged: () => void;
    loadSfeSettings: () => Promise<void>;
    extractConversationIdFromLocation: () => string | null;
    resolveConversationIdForUserAction: () => string | null;
    getCaptureMeta: (cid: string) => ExportMeta;
    resolveIsolatedSnapshotData: (cid: string) => ConversationData | null;
    setStreamProbePanel: (status: string, body: string) => void;
    withPreservedLiveMirrorSnapshot: (cid: string, status: string, body: string) => string;
    syncStreamProbePanelFromCanonical: (cid: string, data: ConversationData) => void;
    appendPendingStreamProbeText: (aid: string, text: string) => void;
    migratePendingStreamProbeText: (cid: string, aid: string) => void;
    appendLiveStreamProbeText: (cid: string, text: string) => void;
    isStaleAttemptMessage: (
        aid: string,
        cid: string | undefined,
        signalType: 'lifecycle' | 'finished' | 'delta' | 'conversation-resolved',
    ) => boolean;
    buildExportPayloadForFormat: (data: ConversationData, format: ExportFormat) => unknown;
    getExportFormat: () => Promise<ExportFormat>;
    emitExternalConversationEvent: (args: {
        conversationId: string;
        data: ConversationData;
        readinessMode: ReadinessDecision['mode'];
        captureMeta: ExportMeta;
        attemptId: string | null;
    }) => void;
    ingestSfeLifecycleFromWirePhase: (
        phase: ResponseLifecycleMessage['phase'],
        aid: string,
        cid?: string | null,
    ) => void;
    buildCalibrationOrchestrationDeps: () => CalibrationOrchestrationDeps;
    buildCalibrationCaptureDeps: (cid: string) => CalibrationCaptureDeps;
    runCalibrationStep: (step: CalibrationStep, cid: string, mode: CalibrationMode) => Promise<boolean>;
    buildWarmFetchDeps: () => WarmFetchDeps;
};

// ── Utility functions (moved from engine) ──

export const extractConversationIdFromLocation = (ctx: EngineCtx): string | null => {
    if (!ctx.currentAdapter) {
        return null;
    }
    return ctx.currentAdapter.extractConversationId(window.location.href) || null;
};

export const resolveConversationIdForUserAction = (ctx: EngineCtx): string | null => {
    const locationId = extractConversationIdFromLocation(ctx);
    if (locationId) {
        return locationId;
    }
    if (ctx.currentConversationId && window.location.href.includes(ctx.currentConversationId)) {
        return ctx.currentConversationId;
    }
    return null;
};

export const getCaptureMeta = (ctx: EngineCtx, conversationId: string): ExportMeta =>
    ctx.captureMetaByConversation.get(conversationId) ?? {
        captureSource: 'canonical_api',
        fidelity: 'high',
        completeness: 'complete',
    };

export const resolveIsolatedSnapshotData = (ctx: EngineCtx, conversationId: string): ConversationData | null => {
    if (!ctx.currentAdapter) {
        return null;
    }
    return buildIsolatedDomSnapshot(ctx.currentAdapter, conversationId);
};

export const evaluateReadinessForData = (ctx: EngineCtx, data: ConversationData): PlatformReadiness =>
    evaluateReadinessForDataPure(data, ctx.currentAdapter);

export const ingestStabilizationRetrySnapshot = (ctx: EngineCtx, conversationId: string, data: unknown) => {
    if (isConversationDataLike(data)) {
        ctx.interceptionManager.ingestConversationData(data, 'stabilization-retry-snapshot');
        return;
    }
    ctx.interceptionManager.ingestInterceptedData({
        url: `stabilization-retry-snapshot://${ctx.currentAdapter?.name ?? 'unknown'}/${conversationId}`,
        data: JSON.stringify(data),
        platform: ctx.currentAdapter?.name ?? 'unknown',
    });
};

export const isPlatformGenerating = (adapter: LLMPlatform | null): boolean => detectPlatformGenerating(adapter);

export const isLifecycleGenerationPhase = (ctx: EngineCtx, conversationId: string): boolean => {
    if (ctx.lifecycleState !== 'prompt-sent' && ctx.lifecycleState !== 'streaming') {
        return false;
    }
    if (!ctx.currentConversationId) {
        return true;
    }
    return ctx.currentConversationId === conversationId;
};

export const shouldBlockActionsForGeneration = (ctx: EngineCtx, conversationId: string): boolean => {
    if (isLifecycleGenerationPhase(ctx, conversationId)) {
        return true;
    }
    if (ctx.currentAdapter?.name !== 'ChatGPT') {
        return false;
    }
    return isPlatformGenerating(ctx.currentAdapter);
};

export const emitStreamDumpConfig = (ctx: EngineCtx) => {
    const payload: StreamDumpConfigMessage = { type: MESSAGE_TYPES.STREAM_DUMP_CONFIG, enabled: ctx.streamDumpEnabled };
    window.postMessage(stampToken(payload), window.location.origin);
};

export const buildExportPayloadForFormat = (ctx: EngineCtx, data: ConversationData, format: ExportFormat): unknown =>
    buildExportPayloadForFormatPure(data, format, ctx.currentAdapter?.name ?? 'Unknown');

export const getExportFormat = (): Promise<ExportFormat> => getExportFormatCore(DEFAULT_EXPORT_FORMAT);

export const emitExternalConversationEvent = (
    ctx: EngineCtx,
    args: {
        conversationId: string;
        data: ConversationData;
        readinessMode: ReadinessDecision['mode'];
        captureMeta: ExportMeta;
        attemptId: string | null;
    },
) => {
    const event = maybeBuildExternalConversationEvent({
        conversationId: args.conversationId,
        data: args.data,
        providerName: ctx.currentAdapter?.name,
        readinessMode: args.readinessMode,
        captureMeta: args.captureMeta,
        attemptId: args.attemptId,
        shouldBlockActions: shouldBlockActionsForGeneration(ctx, args.conversationId),
        evaluateReadinessForData: (data) => evaluateReadinessForData(ctx, data),
        state: ctx.externalEventDispatchState,
    });
    if (!event) {
        return;
    }
    void browser.runtime.sendMessage(buildExternalInternalEventMessage(event)).catch((error) => {
        logger.debug('Failed to send external conversation event to background', {
            conversationId: event.conversation_id,
            type: event.type,
            error,
        });
    });
};

// ── SFE ingestion wrappers ──

const buildSfeIngestionDeps = (ctx: EngineCtx): SfeIngestionDeps => ({
    sfeEnabled: ctx.sfeEnabled,
    sfe: ctx.sfe,
    platformName: ctx.currentAdapter?.name ?? 'Unknown',
    resolveAttemptId: (cid) => ctx.resolveAttemptId(cid),
    bindAttempt: (cid, aid) => ctx.bindAttempt(cid, aid),
    evaluateReadiness: (data) => evaluateReadinessForData(ctx, data),
    getLifecycleState: () => ctx.lifecycleState,
    scheduleCanonicalStabilizationRetry: (cid, aid) => ctx.scheduleCanonicalStabilizationRetry(cid, aid),
    clearCanonicalStabilizationRetry: (aid) => ctx.clearCanonicalStabilizationRetry(aid),
    syncStreamProbePanelFromCanonical: (cid, data) => ctx.syncStreamProbePanelFromCanonical(cid, data),
    refreshButtonState: (cid) => ctx.refreshButtonState(cid),
    structuredLogger: ctx.structuredLogger,
});

export const ingestSfeLifecycle = (
    ctx: EngineCtx,
    phase: LifecyclePhase,
    attemptId: string,
    conversationId?: string | null,
) => ingestSfeLifecycleSignalCore(phase, attemptId, conversationId, buildSfeIngestionDeps(ctx));

export const ingestSfeCanonicalSample = (ctx: EngineCtx, data: ConversationData, attemptId?: string) =>
    ingestSfeCanonicalSampleCore(data, attemptId, buildSfeIngestionDeps(ctx));

export const logSfeMismatchIfNeeded = (ctx: EngineCtx, conversationId: string, legacyReady: boolean) =>
    logSfeMismatchIfNeededCore(conversationId, legacyReady, {
        sfeEnabled: ctx.sfeEnabled,
        sfe: ctx.sfe,
        structuredLogger: ctx.structuredLogger,
        peekAttemptId: (cid) => ctx.peekAttemptId(cid),
    });

export const emitAttemptDisposed = (ctx: EngineCtx, attemptId: string, reason: AttemptDisposedMessage['reason']) =>
    emitAttemptDisposedCore(attemptId, reason, {
        pendingLifecycleByAttempt: ctx.pendingLifecycleByAttempt,
        structuredLogger: ctx.structuredLogger,
        postDisposedMessage: (aid, r) => {
            const payload: AttemptDisposedMessage = {
                type: MESSAGE_TYPES.ATTEMPT_DISPOSED,
                attemptId: aid,
                reason: r as AttemptDisposedMessage['reason'],
            };
            window.postMessage(stampToken(payload), window.location.origin);
        },
    });

export const ingestSfeLifecycleFromWirePhase = (
    ctx: EngineCtx,
    phase: ResponseLifecycleMessage['phase'],
    attemptId: string,
    conversationId?: string | null,
) => ingestSfeLifecycleFromWirePhaseCore(phase, attemptId, conversationId, buildSfeIngestionDeps(ctx));

export const isStaleAttemptMessage = (
    ctx: EngineCtx,
    attemptId: string,
    conversationId: string | undefined,
    signalType: 'lifecycle' | 'finished' | 'delta' | 'conversation-resolved',
): boolean => {
    const deps: StaleAttemptFilterDeps = {
        resolveAliasedAttemptId: (aid) => ctx.resolveAliasedAttemptId(aid),
        isAttemptDisposedOrSuperseded: (aid) => ctx.isAttemptDisposedOrSuperseded(aid),
        attemptByConversation: ctx.attemptByConversation,
        structuredLogger: ctx.structuredLogger,
    };
    return isStaleAttemptMessageCore(attemptId, conversationId, signalType, deps);
};

// ── Deps builder factories ──

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
    getExportFormat,
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
    ingestSfeLifecycle: (phase, aid, cid) => ingestSfeLifecycle(ctx, phase, aid, cid),
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
    removeVisibilityChangeListener: () => {}, // set externally after creation
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
