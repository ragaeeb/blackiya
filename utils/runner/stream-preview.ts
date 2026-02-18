import { setBoundedMapValue } from '@/utils/bounded-collections';
import { appendStreamProbePreview } from '@/utils/runner/stream-probe';

const DEFAULT_MAX_PREVIEW_LENGTH = 15_503;

export type RunnerStreamPreviewState = {
    liveByConversation: Map<string, string>;
    liveByAttemptWithoutConversation: Map<string, string>;
    preservedByConversation: Map<string, string>;
    maxEntries: number;
    maxPreviewLength?: number;
};

export function mergeRunnerStreamProbeText(current: string, text: string): string {
    if (text.startsWith(current)) {
        return text; // Snapshot-style update (preferred)
    }
    if (current.startsWith(text)) {
        return current; // Stale/shorter snapshot, ignore
    }
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
    return needsSpaceJoin ? `${current} ${text}` : `${current}${text}`;
}

export function withPreservedRunnerStreamMirrorSnapshot(
    state: RunnerStreamPreviewState,
    conversationId: string,
    status: string,
    primaryBody: string,
): string {
    if (!status.startsWith('stream-done:')) {
        return primaryBody;
    }

    const liveSnapshot = state.liveByConversation.get(conversationId) ?? '';
    if (liveSnapshot.length === 0) {
        return primaryBody;
    }

    setBoundedMapValue(state.preservedByConversation, conversationId, liveSnapshot, state.maxEntries);
    const normalizedPrimary = primaryBody.trim();
    const normalizedLive = liveSnapshot.trim();
    if (normalizedPrimary.length > 0 && normalizedPrimary === normalizedLive) {
        return primaryBody;
    }

    const boundedSnapshot = normalizedLive.length > 4000 ? `...${normalizedLive.slice(-3800)}` : normalizedLive;
    return `${primaryBody}\n\n--- Preserved live mirror snapshot (pre-final) ---\n${boundedSnapshot}`;
}

export function appendPendingRunnerStreamPreview(
    state: RunnerStreamPreviewState,
    canonicalAttemptId: string,
    text: string,
): string {
    const current = state.liveByAttemptWithoutConversation.get(canonicalAttemptId) ?? '';
    const next = mergeRunnerStreamProbeText(current, text);
    const capped = appendStreamProbePreview('', next, state.maxPreviewLength ?? DEFAULT_MAX_PREVIEW_LENGTH);
    setBoundedMapValue(state.liveByAttemptWithoutConversation, canonicalAttemptId, capped, state.maxEntries);
    return capped;
}

export function migratePendingRunnerStreamPreview(
    state: RunnerStreamPreviewState,
    conversationId: string,
    canonicalAttemptId: string,
): string | null {
    const pending = state.liveByAttemptWithoutConversation.get(canonicalAttemptId);
    if (!pending) {
        return null;
    }
    state.liveByAttemptWithoutConversation.delete(canonicalAttemptId);
    const current = state.liveByConversation.get(conversationId) ?? '';
    const merged = mergeRunnerStreamProbeText(current, pending);
    const capped = appendStreamProbePreview('', merged, state.maxPreviewLength ?? DEFAULT_MAX_PREVIEW_LENGTH);
    setBoundedMapValue(state.liveByConversation, conversationId, capped, state.maxEntries);
    return capped;
}

export function appendLiveRunnerStreamPreview(
    state: RunnerStreamPreviewState,
    conversationId: string,
    text: string,
): string {
    const current = state.liveByConversation.get(conversationId) ?? '';
    const next = mergeRunnerStreamProbeText(current, text);
    const capped = appendStreamProbePreview('', next, state.maxPreviewLength ?? DEFAULT_MAX_PREVIEW_LENGTH);
    setBoundedMapValue(state.liveByConversation, conversationId, capped, state.maxEntries);
    return capped;
}
