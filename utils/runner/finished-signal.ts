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
 * Returns `true` when a terminal canonical network capture should promote the
 * lifecycle to `completed`. This covers both Grok responses without a
 * dedicated completion signal and completed ChatGPT history loaded without a
 * live prompt/stream lifecycle.
 */
export const shouldPromoteFromCanonicalCapture = (
    source: 'network' | 'dom',
    cachedReady: boolean,
    lifecycle: RunnerLifecycleUiState,
    adapterName: string | null,
): boolean => {
    const supportsCanonicalCompletion = adapterName === 'ChatGPT' || adapterName === 'Grok';
    if (source !== 'network' || !supportsCanonicalCompletion || !cachedReady) {
        return false;
    }
    return lifecycle === 'idle' || lifecycle === 'prompt-sent' || lifecycle === 'streaming';
};
