/**
 * Pure helpers for response-finished signal debounce and lifecycle promotion.
 * No side effects — fully testable without a DOM or runner closure.
 */

import type { RunnerLifecycleUiState } from '@/utils/runner/state';

export type FinishedSignalDebounceResult = {
    minIntervalMs: number;
    effectiveAttemptId: string;
};

/**
 * Computes the minimum interval before the next response-finished signal for a
 * conversation should be processed. Network signals from a *new* attempt in the
 * same conversation use a shorter window; DOM and same-attempt network signals
 * use longer ones to suppress spurious duplicates.
 */
export const resolveFinishedSignalDebounce = (
    conversationId: string,
    source: 'network' | 'dom',
    attemptId: string | null,
    lastFinishedConversationId: string | null,
    lastFinishedAttemptId: string | null,
): FinishedSignalDebounceResult => {
    const isSameConversation = conversationId === lastFinishedConversationId;
    const effectiveAttemptId = attemptId ?? '';
    const isNewAttemptInSameConversation =
        source === 'network' &&
        isSameConversation &&
        !!lastFinishedAttemptId &&
        lastFinishedAttemptId !== effectiveAttemptId;
    return {
        minIntervalMs: source === 'network' ? (isNewAttemptInSameConversation ? 900 : 4500) : 1500,
        effectiveAttemptId,
    };
};

/**
 * Returns `true` when a Grok network capture that arrives while the lifecycle
 * is still active (not yet `completed`) should promote the lifecycle to
 * `completed`. Grok does not always emit a dedicated completion signal, so a
 * ready canonical capture serves as an implicit completion hint.
 */
export const shouldPromoteGrokFromCanonicalCapture = (
    source: 'network' | 'dom',
    cachedReady: boolean,
    lifecycle: RunnerLifecycleUiState,
    adapterName: string | null,
): boolean => {
    if (source !== 'network' || adapterName !== 'Grok' || !cachedReady) {
        return false;
    }
    return lifecycle === 'idle' || lifecycle === 'prompt-sent' || lifecycle === 'streaming';
};
