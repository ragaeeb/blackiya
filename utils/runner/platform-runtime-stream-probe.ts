import type { RunnerStreamPreviewState } from '@/utils/runner/stream-preview';
import type { StreamProbePanelDeps, SyncStreamProbePanelDeps } from '@/utils/runner/stream-probe-runtime';
import {
    appendLiveStreamProbeText as appendLiveStreamProbeTextCore,
    appendPendingStreamProbeText as appendPendingStreamProbeTextCore,
    migratePendingStreamProbeText as migratePendingStreamProbeTextCore,
    setStreamProbePanel as setStreamProbePanelCore,
    syncStreamProbePanelFromCanonical as syncStreamProbePanelFromCanonicalCore,
    withPreservedLiveMirrorSnapshot as withPreservedLiveMirrorSnapshotCore,
} from '@/utils/runner/stream-probe-runtime';
import type { ConversationData } from '@/utils/types';

export type StreamProbeRuntimeDeps = {
    streamPreviewState: RunnerStreamPreviewState;
    isCleanedUp: () => boolean;
    isStreamProbeVisible: () => boolean;
    getAdapterName: () => string;
    getHostname: () => string;
    getLastStreamProbeConversationId: () => string | null;
};

export const createStreamProbeRuntime = (deps: StreamProbeRuntimeDeps) => {
    const setStreamProbePanel = (status: string, body: string) => {
        const panelDeps: StreamProbePanelDeps = {
            isCleanedUp: deps.isCleanedUp,
            isStreamProbeVisible: deps.isStreamProbeVisible,
            getAdapterName: deps.getAdapterName,
            getHostname: deps.getHostname,
        };
        setStreamProbePanelCore(status, body, panelDeps);
    };

    const withPreservedLiveMirrorSnapshot = (conversationId: string, status: string, primaryBody: string) =>
        withPreservedLiveMirrorSnapshotCore(deps.streamPreviewState, conversationId, status, primaryBody);

    const syncStreamProbePanelFromCanonical = (conversationId: string, data: ConversationData) => {
        const syncDeps: SyncStreamProbePanelDeps = {
            lastStreamProbeConversationId: deps.getLastStreamProbeConversationId(),
            getAdapterName: () => deps.getAdapterName() || 'Unknown',
            setStreamProbePanel,
            withPreservedLiveMirrorSnapshot,
        };
        syncStreamProbePanelFromCanonicalCore(conversationId, data, syncDeps);
    };

    const appendPendingStreamProbeText = (canonicalAttemptId: string, text: string) => {
        appendPendingStreamProbeTextCore(deps.streamPreviewState, canonicalAttemptId, text, setStreamProbePanel);
    };

    const migratePendingStreamProbeText = (conversationId: string, canonicalAttemptId: string) => {
        migratePendingStreamProbeTextCore(
            deps.streamPreviewState,
            conversationId,
            canonicalAttemptId,
            setStreamProbePanel,
        );
    };

    const appendLiveStreamProbeText = (conversationId: string, text: string) => {
        appendLiveStreamProbeTextCore(deps.streamPreviewState, conversationId, text, setStreamProbePanel);
    };

    return {
        setStreamProbePanel,
        withPreservedLiveMirrorSnapshot,
        syncStreamProbePanelFromCanonical,
        appendPendingStreamProbeText,
        migratePendingStreamProbeText,
        appendLiveStreamProbeText,
    };
};
