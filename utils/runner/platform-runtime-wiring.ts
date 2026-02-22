import type { LLMPlatform } from '@/platforms/types';
import { streamDumpStorage } from '@/utils/diagnostics-stream-dump';
import { logger } from '@/utils/logger';
import type { ResponseLifecycleMessage } from '@/utils/protocol/messages';
import type { AutoCaptureReason } from '@/utils/runner/auto-capture';
import type { LifecyclePhaseHandlerDeps } from '@/utils/runner/lifecycle-phase-handler';
import { applyLifecyclePhaseForConversation as applyLifecyclePhaseForConversationCore } from '@/utils/runner/lifecycle-phase-handler';
import type { NavigationDeps } from '@/utils/runner/navigation-handler';
import { handleNavigationChange as handleNavigationChangeCore } from '@/utils/runner/navigation-handler';
import type {
    ButtonHealthCheckDeps,
    CompletionWatcherDeps,
    RunnerWindowBridgeDeps,
} from '@/utils/runner/runtime-observers';
import {
    registerButtonHealthCheck as registerButtonHealthCheckCore,
    registerCompletionWatcher as registerCompletionWatcherCore,
    registerWindowBridge as registerWindowBridgeCore,
} from '@/utils/runner/runtime-observers';
import type { RunnerStreamPreviewState } from '@/utils/runner/stream-preview';
import type { WarmFetchReason } from '@/utils/runner/warm-fetch';
import type { WireMessageHandlerDeps } from '@/utils/runner/wire-message-handlers';
import {
    handleAttemptDisposedMessage as handleAttemptDisposedMessageCore,
    handleConversationIdResolvedMessage as handleConversationIdResolvedMessageCore,
    handleLifecycleMessage as handleLifecycleMessageCore,
    handleResponseFinishedMessage as handleResponseFinishedMessageCore,
    handleStreamDeltaMessage as handleStreamDeltaMessageCore,
    handleStreamDumpFrameMessage as handleStreamDumpFrameMessageCore,
    handleTitleResolvedMessage as handleTitleResolvedMessageCore,
} from '@/utils/runner/wire-message-handlers';
import type { ExportMeta } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

export type RuntimeWiringDeps = {
    getAdapter: () => LLMPlatform | null;
    getCurrentConversationId: () => string | null;
    getActiveAttemptId: () => string | null;
    resolveAliasedAttemptId: (attemptId: string) => string;
    isStaleAttemptMessage: (
        attemptId: string,
        conversationId: string | undefined,
        signalType: 'lifecycle' | 'finished' | 'delta' | 'conversation-resolved',
    ) => boolean;
    forwardAttemptAlias: (fromAttemptId: string, toAttemptId: string, reason: 'superseded' | 'rebound') => void;
    setActiveAttempt: (attemptId: string | null) => void;
    setCurrentConversation: (conversationId: string | null) => void;
    bindAttempt: (conversationId: string | undefined, attemptId: string) => void;
    getLifecycleState: () => 'idle' | 'prompt-sent' | 'streaming' | 'completed';
    setLifecycleState: (state: 'idle' | 'prompt-sent' | 'streaming' | 'completed', conversationId?: string) => void;
    getLifecycleAttemptId: () => string | null;
    setLifecycleAttemptId: (attemptId: string | null) => void;
    getLifecycleConversationId: () => string | null;
    setLifecycleConversationId: (conversationId: string | null) => void;
    isPlatformGenerating: () => boolean;
    streamResolvedTitles: Map<string, string>;
    maxStreamResolvedTitles: number;
    getConversation: (conversationId: string) => ConversationData | undefined;
    cachePendingLifecycleSignal: (
        attemptId: string,
        phase: ResponseLifecycleMessage['phase'],
        platform: string,
    ) => void;
    ingestSfeLifecycleFromWirePhase: (
        phase: ResponseLifecycleMessage['phase'],
        attemptId: string,
        conversationId?: string | null,
    ) => void;
    handleResponseFinished: (source: 'network' | 'dom', hintedConversationId?: string) => void;
    appendPendingStreamProbeText: (attemptId: string, text: string) => void;
    appendLiveStreamProbeText: (conversationId: string, text: string) => void;
    isStreamDumpEnabled: () => boolean;
    pendingLifecycleByAttempt: Map<
        string,
        { phase: ResponseLifecycleMessage['phase']; platform: string; receivedAtMs: number }
    >;
    sfeUpdateConversationId: (attemptId: string, conversationId: string) => void;
    refreshButtonState: (conversationId?: string) => void;
    cancelStreamDoneProbe: (attemptId: string, reason: 'superseded' | 'disposed') => void;
    clearCanonicalStabilizationRetry: (attemptId: string) => void;
    sfeDispose: (attemptId: string) => void;
    streamPreviewState: RunnerStreamPreviewState;
    attemptByConversation: Map<string, string>;
    shouldRemoveDisposedAttemptBinding: (
        mappedAttemptId: string,
        disposedAttemptId: string,
        resolveAttemptId: (attemptId: string) => string,
    ) => boolean;
    getCaptureMeta: (conversationId: string) => ExportMeta;
    shouldIngestAsCanonicalSample: typeof import('@/utils/sfe/capture-fidelity').shouldIngestAsCanonicalSample;
    scheduleCanonicalStabilizationRetry: (conversationId: string, attemptId: string) => void;
    runStreamDoneProbe: (conversationId: string | undefined, attemptId: string) => Promise<void>;
    setStreamProbePanel: (status: string, body: string) => void;
    liveStreamPreviewByConversation: Map<string, string>;
    sfeEnabled: () => boolean;
    sfeResolve: (attemptId: string) => { ready: boolean; phase: string; blockingConditions: string[] };
    getLastInvalidSessionTokenLogAt: () => number;
    setLastInvalidSessionTokenLogAt: (value: number) => void;
    extractConversationIdFromLocation: () => string | null;
    buttonManagerExists: () => boolean;
    injectSaveButton: () => void;
    isLifecycleActiveGeneration: () => boolean;
    updateAdapter: (adapter: LLMPlatform | null) => void;
    buttonManagerRemove: () => void;
    resetCalibrationPreference: () => void;
    ensureCalibrationPreferenceLoaded: (platformName: string) => Promise<void>;
    warmFetch: (conversationId: string, reason: WarmFetchReason) => Promise<boolean>;
    maybeRunAutoCapture: (conversationId: string, reason: AutoCaptureReason) => void;
    disposeInFlightAttemptsOnNavigation: (preserveConversationId?: string | null) => void;
};

export const createRuntimeWiring = (deps: RuntimeWiringDeps) => {
    const buildLifecyclePhaseHandlerDeps = (): LifecyclePhaseHandlerDeps => ({
        getLifecycleState: deps.getLifecycleState,
        getLifecycleConversationId: deps.getLifecycleConversationId,
        getLifecycleAttemptId: deps.getLifecycleAttemptId,
        setLifecycleAttemptId: (id) => {
            deps.setLifecycleAttemptId(id);
        },
        setLifecycleConversationId: (id) => {
            deps.setLifecycleConversationId(id);
        },
        setLifecycleState: deps.setLifecycleState,
        streamPreviewState: deps.streamPreviewState,
        liveStreamPreviewByConversation: deps.liveStreamPreviewByConversation,
        setStreamProbePanel: deps.setStreamProbePanel,
        ingestSfeLifecycleFromWirePhase: deps.ingestSfeLifecycleFromWirePhase,
        sfeEnabled: deps.sfeEnabled,
        sfeResolve: deps.sfeResolve,
        getCaptureMeta: deps.getCaptureMeta,
        shouldIngestAsCanonicalSample: deps.shouldIngestAsCanonicalSample,
        scheduleCanonicalStabilizationRetry: deps.scheduleCanonicalStabilizationRetry,
        runStreamDoneProbe: (cid, aid) => {
            void deps.runStreamDoneProbe(cid, aid);
        },
    });

    const applyLifecyclePhaseForConversation = (
        phase: ResponseLifecycleMessage['phase'],
        platform: string,
        attemptId: string,
        conversationId: string,
        source: 'direct' | 'replayed',
    ) =>
        applyLifecyclePhaseForConversationCore(
            phase,
            platform,
            attemptId,
            conversationId,
            source,
            buildLifecyclePhaseHandlerDeps(),
        );

    const buildWireMessageHandlerDeps = (): WireMessageHandlerDeps => ({
        getAdapter: deps.getAdapter,
        getCurrentConversationId: deps.getCurrentConversationId,
        getActiveAttemptId: deps.getActiveAttemptId,
        resolveAliasedAttemptId: deps.resolveAliasedAttemptId,
        isStaleAttemptMessage: deps.isStaleAttemptMessage,
        forwardAttemptAlias: deps.forwardAttemptAlias,
        setActiveAttempt: deps.setActiveAttempt,
        setCurrentConversation: deps.setCurrentConversation,
        bindAttempt: deps.bindAttempt,
        getLifecycleState: deps.getLifecycleState,
        setLifecycleState: deps.setLifecycleState,
        setLifecycleAttemptId: (id) => {
            deps.setLifecycleAttemptId(id);
        },
        setLifecycleConversationId: (id) => {
            deps.setLifecycleConversationId(id);
        },
        isPlatformGenerating: deps.isPlatformGenerating,
        streamResolvedTitles: deps.streamResolvedTitles,
        maxStreamResolvedTitles: deps.maxStreamResolvedTitles,
        getConversation: deps.getConversation,
        cachePendingLifecycleSignal: (attemptId, phase, platform) =>
            deps.cachePendingLifecycleSignal(attemptId, phase, platform),
        ingestSfeLifecycleFromWirePhase: deps.ingestSfeLifecycleFromWirePhase,
        applyLifecyclePhaseForConversation,
        handleResponseFinished: deps.handleResponseFinished,
        appendPendingStreamProbeText: deps.appendPendingStreamProbeText,
        appendLiveStreamProbeText: deps.appendLiveStreamProbeText,
        isStreamDumpEnabled: deps.isStreamDumpEnabled,
        saveStreamDumpFrame: (frame) => {
            void streamDumpStorage.saveFrame(frame);
        },
        pendingLifecycleByAttempt: deps.pendingLifecycleByAttempt,
        sfeUpdateConversationId: deps.sfeUpdateConversationId,
        refreshButtonState: deps.refreshButtonState,
        cancelStreamDoneProbe: deps.cancelStreamDoneProbe,
        clearCanonicalStabilizationRetry: deps.clearCanonicalStabilizationRetry,
        sfeDispose: deps.sfeDispose,
        streamPreviewState: deps.streamPreviewState,
        attemptByConversation: deps.attemptByConversation,
        shouldRemoveDisposedAttemptBinding: deps.shouldRemoveDisposedAttemptBinding,
    });

    const handleTitleResolvedMessage = (message: unknown) =>
        handleTitleResolvedMessageCore(message, buildWireMessageHandlerDeps());

    const handleResponseFinishedMessage = (message: unknown) =>
        handleResponseFinishedMessageCore(message, buildWireMessageHandlerDeps());

    const handleLifecycleMessage = (message: unknown) =>
        handleLifecycleMessageCore(message, buildWireMessageHandlerDeps());

    const handleStreamDeltaMessage = (message: unknown) =>
        handleStreamDeltaMessageCore(message, buildWireMessageHandlerDeps());

    const handleStreamDumpFrameMessage = (message: unknown) =>
        handleStreamDumpFrameMessageCore(message, buildWireMessageHandlerDeps());

    const handleConversationIdResolvedMessage = (message: unknown) =>
        handleConversationIdResolvedMessageCore(message, buildWireMessageHandlerDeps());

    const handleAttemptDisposedMessage = (message: unknown) =>
        handleAttemptDisposedMessageCore(message, buildWireMessageHandlerDeps());

    const buildWindowBridgeDeps = (): RunnerWindowBridgeDeps => ({
        messageHandlers: [
            handleAttemptDisposedMessage,
            handleConversationIdResolvedMessage,
            handleStreamDeltaMessage,
            handleStreamDumpFrameMessage,
            handleTitleResolvedMessage,
            handleLifecycleMessage,
            handleResponseFinishedMessage,
        ],
        invalidSessionTokenLogAtRef: {
            get value() {
                return deps.getLastInvalidSessionTokenLogAt();
            },
            set value(next: number) {
                deps.setLastInvalidSessionTokenLogAt(next);
            },
        },
    });

    const registerWindowBridge = () => registerWindowBridgeCore(buildWindowBridgeDeps());

    const buildCompletionWatcherDeps = (): CompletionWatcherDeps => ({
        getAdapter: deps.getAdapter,
        isPlatformGenerating: deps.isPlatformGenerating,
        handleResponseFinished: deps.handleResponseFinished,
    });

    const registerCompletionWatcher = () => registerCompletionWatcherCore(buildCompletionWatcherDeps());

    const buildButtonHealthCheckDeps = (): ButtonHealthCheckDeps => ({
        getAdapter: deps.getAdapter,
        extractConversationIdFromLocation: deps.extractConversationIdFromLocation,
        buttonManagerExists: deps.buttonManagerExists,
        injectSaveButton: deps.injectSaveButton,
        refreshButtonState: deps.refreshButtonState,
    });

    const registerButtonHealthCheck = () => registerButtonHealthCheckCore(buildButtonHealthCheckDeps());

    const buildNavigationDeps = (): NavigationDeps => ({
        getCurrentAdapter: deps.getAdapter,
        getCurrentConversationId: deps.getCurrentConversationId,
        getLifecycleState: deps.getLifecycleState,
        isLifecycleActiveGeneration: deps.isLifecycleActiveGeneration,
        setCurrentConversation: deps.setCurrentConversation,
        setLifecycleState: deps.setLifecycleState,
        updateAdapter: deps.updateAdapter,
        disposeInFlightAttempts: deps.disposeInFlightAttemptsOnNavigation,
        buttonManagerRemove: deps.buttonManagerRemove,
        buttonManagerExists: deps.buttonManagerExists,
        injectSaveButton: deps.injectSaveButton,
        refreshButtonState: deps.refreshButtonState,
        resetCalibrationPreference: deps.resetCalibrationPreference,
        ensureCalibrationPreferenceLoaded: deps.ensureCalibrationPreferenceLoaded,
        warmFetch: deps.warmFetch,
        scheduleAutoCapture: deps.maybeRunAutoCapture,
    });

    const handleNavigationChange = () => {
        handleNavigationChangeCore(buildNavigationDeps());
    };

    const disposeInFlightAttemptsOnNavigation = (preserveConversationId?: string | null) => {
        deps.disposeInFlightAttemptsOnNavigation(preserveConversationId);
        if (!preserveConversationId) {
            logger.debug('Navigation state reset without preserved conversation id');
        }
    };

    return {
        registerWindowBridge,
        registerCompletionWatcher,
        registerButtonHealthCheck,
        handleNavigationChange,
        disposeInFlightAttemptsOnNavigation,
        applyLifecyclePhaseForConversation,
    };
};
