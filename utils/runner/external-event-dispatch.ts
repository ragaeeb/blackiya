import type { ExternalConversationEvent, ExternalInternalEventMessage } from '@/utils/external-api/contracts';
import { EXTERNAL_API_VERSION, EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE, normalizeExternalProvider } from '@/utils/external-api/contracts';
import type { ExportMeta, PlatformReadiness } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

type ExternalDispatchStatus = {
    hasReady: boolean;
    lastContentHash: string | null;
};

export type ExternalEventDispatcherState = {
    byConversation: Map<string, ExternalDispatchStatus>;
};

type MaybeBuildExternalConversationEventArgs = {
    conversationId: string;
    data: ConversationData | null | undefined;
    providerName: string | null | undefined;
    readinessMode: string;
    captureMeta: ExportMeta;
    attemptId: string | null | undefined;
    shouldBlockActions: boolean;
    evaluateReadinessForData: (data: ConversationData) => PlatformReadiness;
    state: ExternalEventDispatcherState;
    now?: () => number;
    createEventId?: () => string;
};

const defaultNow = () => Date.now();

const defaultCreateEventId = (): string => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return crypto.randomUUID();
    }
    return `evt:${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const createExternalEventDispatcherState = (): ExternalEventDispatcherState => ({
    byConversation: new Map(),
});

const shouldEmit = (args: MaybeBuildExternalConversationEventArgs): args is MaybeBuildExternalConversationEventArgs & { data: ConversationData } => {
    if (!args.data) {
        return false;
    }
    if (args.readinessMode !== 'canonical_ready') {
        return false;
    }
    if (args.shouldBlockActions) {
        return false;
    }
    if (args.captureMeta.captureSource !== 'canonical_api') {
        return false;
    }
    return true;
};

export const maybeBuildExternalConversationEvent = (
    args: MaybeBuildExternalConversationEventArgs,
): ExternalConversationEvent | null => {
    if (!shouldEmit(args)) {
        return null;
    }

    const readiness = args.evaluateReadinessForData(args.data);
    const contentHash = readiness.contentHash ?? null;
    const existing = args.state.byConversation.get(args.conversationId);

    if (existing?.hasReady && existing.lastContentHash === contentHash) {
        return null;
    }

    const eventType: ExternalConversationEvent['type'] = existing?.hasReady ? 'conversation.updated' : 'conversation.ready';
    args.state.byConversation.set(args.conversationId, { hasReady: true, lastContentHash: contentHash });

    return {
        api: EXTERNAL_API_VERSION,
        type: eventType,
        event_id: (args.createEventId ?? defaultCreateEventId)(),
        ts: (args.now ?? defaultNow)(),
        provider: normalizeExternalProvider(args.providerName),
        conversation_id: args.conversationId,
        payload: args.data,
        attempt_id: args.attemptId ?? null,
        capture_meta: args.captureMeta,
        content_hash: contentHash,
    };
};

export const buildExternalInternalEventMessage = (event: ExternalConversationEvent): ExternalInternalEventMessage => ({
    type: EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE,
    event,
});
