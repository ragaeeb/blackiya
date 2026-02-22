/**
 * Button state management for the runner.
 *
 * Handles injection, readiness evaluation, refresh scheduling,
 * and calibration state synchronization for the save / calibration buttons.
 */

import type { LLMPlatform } from '@/platforms/types';
import { addBoundedSetValue, setBoundedMapValue } from '@/utils/bounded-collections';
import { logger } from '@/utils/logger';
import type { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import { formatCalibrationTimestampLabel, resolveCalibrationDisplayState } from '@/utils/runner/calibration-ui';
import { resolveRunnerReadinessDecision } from '@/utils/runner/readiness';
import { shouldIngestAsCanonicalSample } from '@/utils/sfe/capture-fidelity';
import type { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';
import type { ExportMeta, PlatformReadiness, ReadinessDecision } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

type CalibrationUiState = 'idle' | 'waiting' | 'capturing' | 'success' | 'error';
type LifecycleUiState = 'idle' | 'prompt-sent' | 'streaming' | 'completed';

export type ButtonStateManagerDeps = {
    getAdapter: () => LLMPlatform | null;
    getCurrentConversationId: () => string | null;
    getLifecycleState: () => LifecycleUiState;
    getCalibrationState: () => CalibrationUiState;
    setCalibrationState: (state: CalibrationUiState) => void;
    getRememberedPreferredStep: () => unknown;
    getRememberedCalibrationUpdatedAt: () => string | null;
    sfeEnabled: () => boolean;
    sfe: SignalFusionEngine;
    attemptByConversation: Map<string, string>;
    captureMetaByConversation: Map<string, ExportMeta>;
    lastCanonicalReadyLogAtByConversation: Map<string, number>;
    timeoutWarningByAttempt: Set<string>;
    maxConversationAttempts: number;
    maxAutocaptureKeys: number;
    canonicalReadyLogTtlMs: number;

    getConversation: (cid: string) => ConversationData | undefined;
    evaluateReadinessForData: (data: ConversationData) => PlatformReadiness;
    peekAttemptId: (cid?: string) => string | null;
    hasCanonicalStabilizationTimedOut: (attemptId: string) => boolean;
    logSfeMismatchIfNeeded: (conversationId: string, legacyReady: boolean) => void;
    ingestSfeCanonicalSample: (data: ConversationData, attemptId?: string) => unknown;

    isLifecycleActiveGeneration: () => boolean;
    shouldBlockActionsForGeneration: (conversationId: string) => boolean;
    setCurrentConversation: (conversationId: string | null) => void;
    setLifecycleState: (state: LifecycleUiState, conversationId?: string) => void;
    syncCalibrationButtonDisplay: () => void;
    syncRunnerStateCalibration: (state: CalibrationUiState) => void;
    emitExternalConversationEvent: (args: {
        conversationId: string;
        data: ConversationData;
        readinessMode: ReadinessDecision['mode'];
        captureMeta: ExportMeta;
        attemptId: string | null;
    }) => void;

    buttonManager: {
        exists: () => boolean;
        inject: (target: HTMLElement, conversationId: string | null) => void;
        setLifecycleState: (state: LifecycleUiState) => void;
        setCalibrationState: (state: CalibrationUiState, options?: { timestampLabel?: string | null }) => void;
        setSaveButtonMode: (mode: 'default' | 'force-degraded') => void;
        setActionButtonsEnabled: (enabled: boolean) => void;
        setOpacity: (opacity: string) => void;
        setButtonEnabled: (button: 'save', enabled: boolean) => void;
        setReadinessSource: (source: 'sfe' | 'legacy') => void;
    };

    structuredLogger: StructuredAttemptLogger;
};

const shouldLogCanonicalReadyDecision = (
    conversationId: string,
    lastCanonicalReadyLogAtByConversation: Map<string, number>,
    maxConversationAttempts: number,
    canonicalReadyLogTtlMs: number,
): boolean => {
    const now = Date.now();
    const lastLoggedAt = lastCanonicalReadyLogAtByConversation.get(conversationId);
    if (lastLoggedAt !== undefined && now - lastLoggedAt < canonicalReadyLogTtlMs) {
        return false;
    }
    setBoundedMapValue(lastCanonicalReadyLogAtByConversation, conversationId, now, maxConversationAttempts);
    return true;
};

const emitTimeoutWarningOnce = (
    attemptId: string,
    conversationId: string,
    timeoutWarningByAttempt: Set<string>,
    maxAutocaptureKeys: number,
    structuredLogger: StructuredAttemptLogger,
) => {
    if (timeoutWarningByAttempt.has(attemptId)) {
        return;
    }
    addBoundedSetValue(timeoutWarningByAttempt, attemptId, maxAutocaptureKeys);
    structuredLogger.emit(
        attemptId,
        'warn',
        'readiness_timeout_manual_only',
        'Stabilization timed out; manual force save required',
        { conversationId },
        `readiness-timeout:${conversationId}`,
    );
};

export const resolveReadinessDecision = (conversationId: string, deps: ButtonStateManagerDeps): ReadinessDecision => {
    const captureMeta = deps.captureMetaByConversation.get(conversationId) ?? {
        captureSource: 'canonical_api' as const,
        fidelity: 'high' as const,
        completeness: 'complete' as const,
    };
    const sfeResolution = deps.sfe.resolveByConversation(conversationId);
    return resolveRunnerReadinessDecision({
        conversationId,
        data: deps.getConversation(conversationId) ?? null,
        sfeEnabled: deps.sfeEnabled(),
        captureMeta,
        sfeResolution: sfeResolution
            ? {
                  ready: sfeResolution.ready,
                  reason: sfeResolution.reason,
                  blockingConditions: [...sfeResolution.blockingConditions],
              }
            : null,
        evaluateReadinessForData: deps.evaluateReadinessForData,
        resolveAttemptId: (cid) => deps.peekAttemptId(cid),
        hasCanonicalStabilizationTimedOut: deps.hasCanonicalStabilizationTimedOut,
        emitTimeoutWarningOnce: (aid, cid) =>
            emitTimeoutWarningOnce(
                aid,
                cid,
                deps.timeoutWarningByAttempt,
                deps.maxAutocaptureKeys,
                deps.structuredLogger,
            ),
        clearTimeoutWarningByAttempt: (attemptId) => {
            deps.timeoutWarningByAttempt.delete(attemptId);
        },
        logSfeMismatchIfNeeded: deps.logSfeMismatchIfNeeded,
        shouldLogCanonicalReadyDecision: (cid) =>
            shouldLogCanonicalReadyDecision(
                cid,
                deps.lastCanonicalReadyLogAtByConversation,
                deps.maxConversationAttempts,
                deps.canonicalReadyLogTtlMs,
            ),
        clearCanonicalReadyLogStamp: (id) => {
            deps.lastCanonicalReadyLogAtByConversation.delete(id);
        },
        loggerDebug: (message, payload) => {
            logger.debug(message, payload);
        },
    });
};

export const isConversationReadyForActions = (
    conversationId: string,
    options: { includeDegraded?: boolean },
    deps: ButtonStateManagerDeps,
): boolean => {
    const decision = resolveReadinessDecision(conversationId, deps);
    if (decision.mode === 'canonical_ready') {
        return true;
    }
    return options.includeDegraded === true && decision.mode === 'degraded_manual_only';
};

export const logButtonStateIfChanged = (
    conversationId: string,
    hasData: boolean,
    opacity: string,
    lastButtonStateLog: { value: string },
    lifecycleState: string,
    getConversation: (cid: string) => ConversationData | undefined,
) => {
    const key = `${conversationId}:${hasData ? 'ready' : 'waiting'}:${opacity}`;
    if (lastButtonStateLog.value === key) {
        return;
    }
    lastButtonStateLog.value = key;
    logger.info('Button state', {
        conversationId,
        hasData,
        opacity,
        lifecycleState,
        hasCachedData: !!getConversation(conversationId),
    });
};

export const refreshButtonState = (
    forConversationId: string | undefined,
    deps: ButtonStateManagerDeps,
    lastButtonStateLog: { value: string },
) => {
    const conversationId = resolveRefreshConversationId(forConversationId, deps);
    if (!conversationId) {
        return;
    }
    if (shouldDisableButtonActions(conversationId, deps)) {
        applyDisabledButtonState(conversationId, deps, lastButtonStateLog);
        return;
    }

    const cached = deps.getConversation(conversationId);
    const captureMeta = deps.captureMetaByConversation.get(conversationId) ?? {
        captureSource: 'canonical_api' as const,
        fidelity: 'high' as const,
        completeness: 'complete' as const,
    };
    if (cached && shouldIngestAsCanonicalSample(captureMeta)) {
        deps.ingestSfeCanonicalSample(cached, deps.attemptByConversation.get(conversationId));
    }

    const decision = resolveReadinessDecision(conversationId, deps);
    const isCanonicalReady = decision.mode === 'canonical_ready';
    const isDegraded = decision.mode === 'degraded_manual_only';
    const hasData = isCanonicalReady || isDegraded;
    const attemptId = deps.peekAttemptId(conversationId);

    deps.buttonManager.setReadinessSource(deps.sfeEnabled() ? 'sfe' : 'legacy');
    deps.buttonManager.setSaveButtonMode(isDegraded ? 'force-degraded' : 'default');
    if (isDegraded) {
        deps.buttonManager.setButtonEnabled('save', true);
    } else {
        deps.buttonManager.setActionButtonsEnabled(isCanonicalReady);
    }

    if (isCanonicalReady && cached) {
        deps.emitExternalConversationEvent({
            conversationId,
            data: cached,
            readinessMode: decision.mode,
            captureMeta,
            attemptId,
        });
    }

    const opacity = hasData ? '1' : '0.6';
    deps.buttonManager.setOpacity(opacity);
    logButtonStateIfChanged(
        conversationId,
        hasData,
        opacity,
        lastButtonStateLog,
        deps.getLifecycleState(),
        deps.getConversation,
    );

    const calibrationState = deps.getCalibrationState();
    if (isCanonicalReady && calibrationState !== 'capturing') {
        deps.setCalibrationState('success');
        deps.syncRunnerStateCalibration('success');
        deps.syncCalibrationButtonDisplay();
    } else if (!isCanonicalReady && calibrationState === 'success') {
        deps.setCalibrationState('idle');
        deps.syncRunnerStateCalibration('idle');
        deps.syncCalibrationButtonDisplay();
    }

};

const resolveRefreshConversationId = (
    forConversationId: string | undefined,
    deps: ButtonStateManagerDeps,
): string | null => {
    const adapter = deps.getAdapter();
    if (!adapter) {
        return null;
    }
    const conversationId = forConversationId || adapter.extractConversationId(window.location.href);
    if (!deps.buttonManager.exists()) {
        return null;
    }
    if (!conversationId) {
        resetButtonStateForNoConversation(deps);
        return null;
    }
    return conversationId;
};

const shouldDisableButtonActions = (conversationId: string, deps: ButtonStateManagerDeps) => {
    const lifecycleState = deps.getLifecycleState();
    const activeGeneration = lifecycleState === 'prompt-sent' || lifecycleState === 'streaming';
    const sameConversation = !deps.getCurrentConversationId() || conversationId === deps.getCurrentConversationId();
    if (activeGeneration && sameConversation) {
        return true;
    }
    return lifecycleState !== 'completed' && deps.shouldBlockActionsForGeneration(conversationId);
};

const applyDisabledButtonState = (
    conversationId: string,
    deps: ButtonStateManagerDeps,
    lastButtonStateLog: { value: string },
) => {
    deps.buttonManager.setSaveButtonMode('default');
    deps.buttonManager.setActionButtonsEnabled(false);
    deps.buttonManager.setOpacity('0.6');
    logButtonStateIfChanged(
        conversationId,
        false,
        '0.6',
        lastButtonStateLog,
        deps.getLifecycleState(),
        deps.getConversation,
    );
};

export const scheduleButtonRefresh = (
    conversationId: string,
    deps: ButtonStateManagerDeps,
    lastButtonStateLog: { value: string },
) => {
    let attempts = 0;
    const maxAttempts = 6;
    const tick = () => {
        attempts += 1;
        if (!deps.buttonManager.exists()) {
            return;
        }
        const decision = resolveReadinessDecision(conversationId, deps);
        if (decision.mode === 'canonical_ready' || decision.mode === 'degraded_manual_only') {
            refreshButtonState(conversationId, deps, lastButtonStateLog);
            return;
        }
        deps.buttonManager.setSaveButtonMode('default');
        deps.buttonManager.setActionButtonsEnabled(false);
        if (attempts < maxAttempts) {
            setTimeout(tick, 500);
        } else {
            logButtonStateIfChanged(
                conversationId,
                false,
                '0.6',
                lastButtonStateLog,
                deps.getLifecycleState(),
                deps.getConversation,
            );
        }
    };
    setTimeout(tick, 500);
};

const resetButtonStateForNoConversation = (deps: ButtonStateManagerDeps) => {
    deps.setCurrentConversation(null);
    if (!deps.isLifecycleActiveGeneration() && deps.getLifecycleState() !== 'idle') {
        deps.setLifecycleState('idle');
    }
    deps.buttonManager.setSaveButtonMode('default');
    deps.buttonManager.setActionButtonsEnabled(false);
    deps.buttonManager.setOpacity('0.6');
};

export const injectSaveButton = (deps: ButtonStateManagerDeps, lastButtonStateLog: { value: string }) => {
    const adapter = deps.getAdapter();
    const conversationId = adapter?.extractConversationId(window.location.href) ?? null;
    const target = adapter?.getButtonInjectionTarget();
    if (!target) {
        logger.info('Button target missing; retry pending', {
            platform: adapter?.name ?? 'unknown',
            conversationId,
        });
        return;
    }
    deps.buttonManager.inject(target, conversationId);
    deps.buttonManager.setLifecycleState(deps.getLifecycleState());
    const displayState = resolveCalibrationDisplayState(
        deps.getCalibrationState(),
        !!deps.getRememberedPreferredStep(),
    );
    deps.buttonManager.setCalibrationState(displayState, {
        timestampLabel:
            displayState === 'success'
                ? formatCalibrationTimestampLabel(deps.getRememberedCalibrationUpdatedAt())
                : null,
    });

    if (!conversationId) {
        logger.info('No conversation ID yet; showing calibration only');
        deps.setCurrentConversation(null);
        if (!deps.isLifecycleActiveGeneration() && deps.getLifecycleState() !== 'idle') {
            deps.setLifecycleState('idle');
        }
        deps.buttonManager.setSaveButtonMode('default');
        deps.buttonManager.setActionButtonsEnabled(false);
        deps.buttonManager.setOpacity('0.6');
        return;
    }
    deps.buttonManager.setActionButtonsEnabled(true);
    deps.setCurrentConversation(conversationId);
    refreshButtonState(conversationId, deps, lastButtonStateLog);
    scheduleButtonRefresh(conversationId, deps, lastButtonStateLog);
};
