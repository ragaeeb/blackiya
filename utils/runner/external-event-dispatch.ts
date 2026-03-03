import { setBoundedMapValue } from '@/utils/bounded-collections';
import type { ExternalInboundConversationEvent, ExternalInternalEventMessage } from '@/utils/external-api/contracts';
import {
    EXTERNAL_API_VERSION,
    EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE,
    normalizeExternalProvider,
} from '@/utils/external-api/contracts';
import type { ExportMeta, PlatformReadiness } from '@/utils/sfe/types';
import { isGenericConversationTitle, resolveExportConversationTitleDecision } from '@/utils/title-resolver';
import type { ConversationData } from '@/utils/types';

type ExternalDispatchStatus = {
    hasReady: boolean;
    lastContentHash: string | null;
    lastPayloadSignature: string;
};

export type ExternalEventDispatcherState = {
    byConversation: Map<string, ExternalDispatchStatus>;
    maxEntries: number;
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

const buildUuidV4FromRandomValues = (): string => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const defaultCreateEventId = (): string => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return crypto.randomUUID();
    }
    if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
        return buildUuidV4FromRandomValues();
    }
    const randomTail = () =>
        `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}${Math.random()
            .toString(16)
            .slice(2)}`;
    return `evt:${Date.now().toString(16)}-${randomTail()}`;
};

const DEFAULT_MAX_EXTERNAL_DISPATCH_ENTRIES = 250;

export const createExternalEventDispatcherState = (
    maxEntries = DEFAULT_MAX_EXTERNAL_DISPATCH_ENTRIES,
): ExternalEventDispatcherState => ({
    byConversation: new Map(),
    maxEntries,
});

const extractMessageText = (message: ConversationData['mapping'][string]['message']): string => {
    if (!message) {
        return '';
    }
    const partsText = Array.isArray(message.content?.parts)
        ? message.content.parts.filter((part): part is string => typeof part === 'string').join('\n')
        : '';
    if (partsText.trim().length > 0) {
        return partsText;
    }
    return typeof message.content?.content === 'string' ? message.content.content : '';
};

const hasNonEmptyUserMessage = (data: ConversationData): boolean =>
    Object.values(data.mapping).some((node) => {
        const message = node.message;
        if (!message || message.author.role !== 'user') {
            return false;
        }
        return extractMessageText(message).trim().length > 0;
    });

const shouldRequirePromptForProvider = (providerName: string | null | undefined): boolean =>
    normalizeExternalProvider(providerName) === 'gemini';

const normalizePayloadForDispatch = (payload: ConversationData): ConversationData => {
    if (!isGenericConversationTitle(payload.title)) {
        return payload;
    }
    const decision = resolveExportConversationTitleDecision(payload);
    const currentTitle = typeof payload.title === 'string' ? payload.title.trim() : '';
    if (decision.title === currentTitle) {
        return payload;
    }
    return {
        ...payload,
        title: decision.title,
    };
};

const stableStringify = (value: unknown): string => {
    if (value === undefined) {
        return 'null';
    }
    if (value === null) {
        return 'null';
    }
    if (typeof value !== 'object') {
        const serialized = JSON.stringify(value);
        return serialized ?? 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
};

const payloadSignatureForDispatch = (payload: ConversationData): string => stableStringify(payload);

const shouldEmit = (
    args: MaybeBuildExternalConversationEventArgs,
): args is MaybeBuildExternalConversationEventArgs & { data: ConversationData } => {
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
    if (shouldRequirePromptForProvider(args.providerName) && !hasNonEmptyUserMessage(args.data)) {
        return false;
    }
    return true;
};

export const maybeBuildExternalConversationEvent = (
    args: MaybeBuildExternalConversationEventArgs,
): ExternalInboundConversationEvent | null => {
    if (!shouldEmit(args)) {
        return null;
    }

    const payload = normalizePayloadForDispatch(args.data);
    const readiness = args.evaluateReadinessForData(args.data);
    const contentHash = readiness.contentHash ?? null;
    const payloadSignature = payloadSignatureForDispatch(payload);
    const existing = args.state.byConversation.get(args.conversationId);
    if (
        existing?.hasReady &&
        existing.lastPayloadSignature === payloadSignature &&
        existing.lastContentHash === contentHash
    ) {
        return null;
    }

    const eventType: ExternalInboundConversationEvent['type'] = existing?.hasReady
        ? 'conversation.updated'
        : 'conversation.ready';

    return {
        api: EXTERNAL_API_VERSION,
        type: eventType,
        event_id: (args.createEventId ?? defaultCreateEventId)(),
        ts: (args.now ?? defaultNow)(),
        provider: normalizeExternalProvider(args.providerName),
        conversation_id: args.conversationId,
        payload,
        attempt_id: args.attemptId ?? null,
        capture_meta: args.captureMeta,
        content_hash: contentHash,
    };
};

export const markExternalConversationEventDispatched = (
    state: ExternalEventDispatcherState,
    conversationId: string,
    _attemptId: string | null | undefined,
    contentHash: string | null,
    payload: ConversationData,
) => {
    setBoundedMapValue(
        state.byConversation,
        conversationId,
        {
            hasReady: true,
            lastContentHash: contentHash,
            lastPayloadSignature: payloadSignatureForDispatch(payload),
        },
        state.maxEntries,
    );
};

export const buildExternalInternalEventMessage = (
    event: ExternalInboundConversationEvent,
): ExternalInternalEventMessage => ({
    type: EXTERNAL_INTERNAL_EVENT_MESSAGE_TYPE,
    event,
});
