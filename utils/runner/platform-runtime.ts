import { shouldRemoveDisposedAttemptBinding as shouldRemoveDisposedAttemptBindingFromRegistry } from '@/utils/runner/attempt-state';
import { buildCalibrationOrderForMode, shouldPersistCalibrationProfile } from '@/utils/runner/calibration-policy';
import {
    beginCanonicalStabilizationTick,
    type CanonicalStabilizationAttemptState,
    clearCanonicalStabilizationAttemptState,
    resolveShouldSkipCanonicalRetryAfterAwait,
} from '@/utils/runner/canonical-stabilization';
import { runPlatform as runPlatformEngine } from '@/utils/runner/platform-runner-engine';
import { resolveExportConversationTitleDecision as resolveExportTitleDecision } from '@/utils/title-resolver';
import type { ConversationData } from '@/utils/types';

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
export const runPlatform = runPlatformEngine;
