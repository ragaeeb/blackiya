import { extractResponseTextFromConversation } from '@/utils/runner/export-helpers';
import {
    ensureStreamProbePanel,
    resolveStreamProbeDockPosition,
    setStreamProbePanelContent,
} from '@/utils/runner/probe-panel';
import {
    appendLiveRunnerStreamPreview,
    appendPendingRunnerStreamPreview,
    migratePendingRunnerStreamPreview,
    type RunnerStreamPreviewState,
    withPreservedRunnerStreamMirrorSnapshot,
} from '@/utils/runner/stream-preview';
import type { ConversationData } from '@/utils/types';

export type StreamProbePanelDeps = {
    isCleanedUp: () => boolean;
    isStreamProbeVisible: () => boolean;
    getAdapterName: () => string;
    getHostname: () => string;
};

export const setStreamProbePanel = (status: string, body: string, deps: StreamProbePanelDeps) => {
    if (deps.isCleanedUp() || !deps.isStreamProbeVisible()) {
        return;
    }
    const dockPosition = resolveStreamProbeDockPosition(deps.getAdapterName(), deps.getHostname());
    const panel = ensureStreamProbePanel(true, dockPosition);
    if (!panel) {
        return;
    }
    setStreamProbePanelContent(panel, status, body);
};

export const withPreservedLiveMirrorSnapshot = (
    streamPreviewState: RunnerStreamPreviewState,
    conversationId: string,
    status: string,
    primaryBody: string,
) => withPreservedRunnerStreamMirrorSnapshot(streamPreviewState, conversationId, status, primaryBody);

export type SyncStreamProbePanelDeps = {
    lastStreamProbeConversationId: string | null;
    getAdapterName: () => string;
    setStreamProbePanel: (status: string, body: string) => void;
    withPreservedLiveMirrorSnapshot: (conversationId: string, status: string, primaryBody: string) => string;
};

export const syncStreamProbePanelFromCanonical = (
    conversationId: string,
    data: ConversationData,
    deps: SyncStreamProbePanelDeps,
) => {
    const panel = document.getElementById('blackiya-stream-probe');
    if (!panel || deps.lastStreamProbeConversationId !== conversationId) {
        return;
    }
    const panelText = panel.textContent ?? '';
    if (!panelText.includes('stream-done: awaiting canonical capture')) {
        return;
    }
    const cachedText = extractResponseTextFromConversation(data, deps.getAdapterName());
    const body = cachedText.length > 0 ? cachedText : '(captured cache ready; no assistant text extracted)';
    deps.setStreamProbePanel(
        'stream-done: canonical capture ready',
        deps.withPreservedLiveMirrorSnapshot(conversationId, 'stream-done: canonical capture ready', body),
    );
};

export const appendPendingStreamProbeText = (
    streamPreviewState: RunnerStreamPreviewState,
    canonicalAttemptId: string,
    text: string,
    setStreamProbePanel: (status: string, body: string) => void,
) => {
    const capped = appendPendingRunnerStreamPreview(streamPreviewState, canonicalAttemptId, text);
    setStreamProbePanel('stream: awaiting conversation id', capped);
};

export const migratePendingStreamProbeText = (
    streamPreviewState: RunnerStreamPreviewState,
    conversationId: string,
    canonicalAttemptId: string,
    setStreamProbePanel: (status: string, body: string) => void,
) => {
    const capped = migratePendingRunnerStreamPreview(streamPreviewState, conversationId, canonicalAttemptId);
    if (!capped) {
        return;
    }
    setStreamProbePanel('stream: live mirror', capped);
};

export const appendLiveStreamProbeText = (
    streamPreviewState: RunnerStreamPreviewState,
    conversationId: string,
    text: string,
    setStreamProbePanel: (status: string, body: string) => void,
) => {
    const capped = appendLiveRunnerStreamPreview(streamPreviewState, conversationId, text);
    setStreamProbePanel('stream: live mirror', capped);
};
