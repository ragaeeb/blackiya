import type { LLMPlatform } from '@/platforms/types';
import type { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import type { InterceptionManager } from '@/utils/managers/interception-manager';
import type { NavigationManager } from '@/utils/managers/navigation-manager';
import type { AttemptDisposedMessage, ResponseLifecycleMessage } from '@/utils/protocol/messages';
import type { AttemptCoordinatorDeps } from '@/utils/runner/attempt-coordinator';
import type { AutoCaptureReason } from '@/utils/runner/auto-capture';
import type { ButtonStateManagerDeps } from '@/utils/runner/button-state-manager';
import type { CalibrationCaptureDeps } from '@/utils/runner/calibration-capture';
import type { CalibrationOrchestrationDeps } from '@/utils/runner/calibration-orchestration';
import type { CalibrationMode } from '@/utils/runner/calibration-policy';
import type { CalibrationStep } from '@/utils/runner/calibration-runner';
import type { CalibrationRuntimeDeps } from '@/utils/runner/runtime/platform-runtime-calibration';
import type { RuntimeWiringDeps } from '@/utils/runner/runtime/platform-runtime-wiring';
import type { RunnerCleanupDeps } from '@/utils/runner/runtime/runtime-cleanup';
import type { SavePipelineDeps } from '@/utils/runner/save-pipeline';
import type { RunnerState } from '@/utils/runner/state';
import type { RunnerStreamPreviewState } from '@/utils/runner/stream/stream-preview';
import type { WarmFetchDeps, WarmFetchReason } from '@/utils/runner/warm-fetch';
import type { CrossTabProbeLease } from '@/utils/sfe/cross-tab-probe-lease';
import type { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';
import type { ExportMeta, LifecyclePhase, PlatformReadiness, ReadinessDecision } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';
import type { ButtonManager } from '@/utils/ui/button-manager';

export type LifecycleUiState = 'idle' | 'prompt-sent' | 'streaming' | 'completed';
export type CalibrationUiState = 'idle' | 'waiting' | 'capturing' | 'success' | 'error';

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

export type EngineCtx = {
    currentAdapter: LLMPlatform | null;
    currentConversationId: string | null;
    lifecycleState: LifecycleUiState;
    lifecycleAttemptId: string | null;
    lifecycleConversationId: string | null;
    calibrationState: CalibrationUiState;
    activeAttemptId: string | null;
    sfeEnabled: boolean;
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
    cleanupRuntimeMessageListener: (() => void) | null;
    lastButtonStateLogRef: { value: string };

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

    sfe: SignalFusionEngine;
    probeLease: CrossTabProbeLease;
    structuredLogger: StructuredAttemptLogger;
    runnerState: RunnerState;
    interceptionManager: InterceptionManager;
    navigationManager: NavigationManager;
    buttonManager: ButtonManager;
    streamPreviewState: RunnerStreamPreviewState;
    externalEventDispatchState: import('@/utils/runner/external-event-dispatch').ExternalEventDispatcherState;
    streamProbeRuntime: ReturnType<
        typeof import('@/utils/runner/runtime/platform-runtime-stream-probe').createStreamProbeRuntime
    > | null;

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
    emitExternalConversationEvent: (args: {
        conversationId: string;
        data: ConversationData;
        readinessMode: ReadinessDecision['mode'];
        captureMeta: ExportMeta;
        attemptId: string | null;
        allowWhenActionsBlocked?: boolean;
        forceEmit?: boolean;
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

export type RunnerEngineCtxDeps = {
    buildAttemptCoordinatorDeps: (ctx: EngineCtx) => AttemptCoordinatorDeps;
    buildButtonStateManagerDeps: (ctx: EngineCtx) => ButtonStateManagerDeps;
    buildCalibrationRuntimeDeps: (ctx: EngineCtx) => CalibrationRuntimeDeps;
    buildRuntimeWiringDeps: (ctx: EngineCtx) => RuntimeWiringDeps;
    buildSavePipelineDeps: (ctx: EngineCtx) => SavePipelineDeps;
    buildCleanupRuntimeDeps: (
        ctx: EngineCtx,
        runnerControl: { cleanup?: () => void },
        storageChangeListener: Parameters<typeof import('wxt/browser').browser.storage.onChanged.addListener>[0],
    ) => RunnerCleanupDeps;
};
