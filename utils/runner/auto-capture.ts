/**
 * Auto-capture orchestration — proactively captures conversation data after
 * a response completes or on navigation, using the remembered calibration strategy.
 *
 * All dependencies are injected so the module is unit-testable in isolation.
 */

import type { LLMPlatform } from '@/platforms/types';
import { addBoundedSetValue, setBoundedMapValue } from '@/utils/bounded-collections';
import { logger } from '@/utils/logger';
import type { CalibrationMode } from '@/utils/runner/calibration-policy';
import type { CalibrationStep } from '@/utils/runner/calibration-runner';

export type AutoCaptureReason = 'response-finished' | 'navigation';

export type AutoCaptureDeps = {
    getAdapter: () => LLMPlatform | null;
    getCalibrationState: () => 'idle' | 'waiting' | 'capturing' | 'success' | 'error';
    isConversationReadyForActions: (conversationId: string, opts?: { includeDegraded?: boolean }) => boolean;
    isPlatformGenerating: (adapter: LLMPlatform | null) => boolean;
    peekAttemptId: (conversationId: string) => string | null;
    resolveAttemptId: (conversationId: string) => string;
    getRememberedPreferredStep: () => CalibrationStep | null;
    isCalibrationPreferenceLoaded: () => boolean;
    ensureCalibrationPreferenceLoaded: (platformName: string) => Promise<void>;
    runCalibrationCapture: (mode: CalibrationMode, hintedConversationId?: string) => Promise<void>;
    autoCaptureAttempts: Map<string, number>;
    autoCaptureRetryTimers: Map<string, number>;
    autoCaptureDeferredLogged: Set<string>;
    maxKeys: number;
};

/**
 * Returns `true` when auto-capture should be skipped entirely — either because
 * there is no adapter, calibration is active, or the conversation is already ready.
 */
export const shouldSkipAutoCapture = (conversationId: string, deps: AutoCaptureDeps): boolean =>
    !deps.getAdapter() ||
    deps.getCalibrationState() !== 'idle' ||
    deps.isConversationReadyForActions(conversationId, { includeDegraded: true });

/**
 * Returns `true` when the attempt key was captured recently enough to suppress
 * a redundant auto-capture run. Stamps the current time on first or expired entry.
 */
const shouldThrottleAutoCapture = (attemptKey: string, deps: AutoCaptureDeps): boolean => {
    const now = Date.now();
    const lastAttempt = deps.autoCaptureAttempts.get(attemptKey) ?? 0;
    if (now - lastAttempt < 12_000) {
        return true;
    }
    setBoundedMapValue(deps.autoCaptureAttempts, attemptKey, now, deps.maxKeys);
    return false;
};

/**
 * Schedules a deferred retry of `maybeRunAutoCapture` for when the platform is
 * still generating. Logs once per attempt key to avoid flooding.
 */
const scheduleDeferredAutoCapture = (
    attemptKey: string,
    conversationId: string,
    reason: AutoCaptureReason,
    deps: AutoCaptureDeps,
): void => {
    if (deps.autoCaptureRetryTimers.has(attemptKey)) {
        return;
    }
    if (!deps.autoCaptureDeferredLogged.has(attemptKey)) {
        logger.info('Auto calibration deferred: response still generating', {
            platform: deps.getAdapter()?.name ?? 'Unknown',
            conversationId,
            reason,
        });
        addBoundedSetValue(deps.autoCaptureDeferredLogged, attemptKey, deps.maxKeys);
    }
    const timerId = window.setTimeout(() => {
        deps.autoCaptureRetryTimers.delete(attemptKey);
        maybeRunAutoCapture(conversationId, reason, deps);
    }, 4_000);
    deps.autoCaptureRetryTimers.set(attemptKey, timerId);
};

/**
 * Runs the calibration capture using the remembered preferred step, or defers
 * until the calibration preference is loaded when not yet available.
 */
const runAutoCaptureFromPreference = (
    conversationId: string,
    reason: AutoCaptureReason,
    deps: AutoCaptureDeps,
): void => {
    const run = () => {
        if (shouldSkipAutoCapture(conversationId, deps) || !deps.getRememberedPreferredStep()) {
            return;
        }
        logger.info('Auto calibration run from remembered strategy', {
            platform: deps.getAdapter()?.name ?? 'Unknown',
            conversationId,
            preferredStep: deps.getRememberedPreferredStep(),
            reason,
        });
        void deps.runCalibrationCapture('auto', conversationId);
    };

    if (deps.getRememberedPreferredStep() || deps.isCalibrationPreferenceLoaded()) {
        run();
        return;
    }
    const adapter = deps.getAdapter();
    if (!adapter) {
        return;
    }
    void deps.ensureCalibrationPreferenceLoaded(adapter.name).then(run);
};

/**
 * Entry point for post-response and post-navigation auto-capture. Defers when
 * ChatGPT is still generating, throttles repeated runs, and delegates to the
 * remembered calibration strategy.
 */
export const maybeRunAutoCapture = (conversationId: string, reason: AutoCaptureReason, deps: AutoCaptureDeps): void => {
    if (shouldSkipAutoCapture(conversationId, deps)) {
        return;
    }
    const adapter = deps.getAdapter();
    if (!adapter) {
        return;
    }
    let attemptKey = deps.peekAttemptId(conversationId);
    if (adapter.name === 'ChatGPT' && deps.isPlatformGenerating(adapter)) {
        if (!attemptKey) {
            attemptKey = deps.resolveAttemptId(conversationId);
        }
        scheduleDeferredAutoCapture(attemptKey, conversationId, reason, deps);
        return;
    }
    if (attemptKey) {
        deps.autoCaptureDeferredLogged.delete(attemptKey);
    }
    if (attemptKey && shouldThrottleAutoCapture(attemptKey, deps)) {
        return;
    }
    runAutoCaptureFromPreference(conversationId, reason, deps);
};
