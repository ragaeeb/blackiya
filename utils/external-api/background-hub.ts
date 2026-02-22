import { setBoundedMapValue } from '@/utils/bounded-collections';
import { buildCommonExport } from '@/utils/common-export';
import type {
    ExternalConversationEvent,
    ExternalConversationSuccessResponse,
    ExternalFailureResponse,
    ExternalPullFormat,
    ExternalRequest,
    ExternalResponse,
    ExternalHealthSuccessResponse,
} from '@/utils/external-api/contracts';
import { EXTERNAL_API_VERSION, EXTERNAL_EVENTS_PORT_NAME, isExternalRequest } from '@/utils/external-api/contracts';
import type { ConversationData } from '@/utils/types';

export type ExternalStorageLike = {
    get: (key: string) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
};

export type ExternalPortLike = {
    name: string;
    postMessage: (message: unknown) => void;
    disconnect?: () => void;
    onDisconnect: {
        addListener: (listener: (port: ExternalPortLike) => void) => void;
        removeListener?: (listener: (port: ExternalPortLike) => void) => void;
    };
};

type CachedConversationRecord = {
    conversation_id: string;
    provider: ExternalConversationEvent['provider'];
    payload: ConversationData;
    attempt_id?: string | null;
    capture_meta: ExternalConversationEvent['capture_meta'];
    content_hash: string | null;
    ts: number;
    tab_id?: number;
};

type PersistedCacheState = {
    latestConversationId: string | null;
    records: CachedConversationRecord[];
};

type ExternalApiHubDeps = {
    storage: ExternalStorageLike;
    now?: () => number;
    maxCachedConversations?: number;
    storageKey?: string;
};

const DEFAULT_MAX_CACHED_CONVERSATIONS = 50;
const DEFAULT_STORAGE_KEY = 'blackiya_external_api_cache_v1';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

const hasString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isConversationDataLike = (value: unknown): value is ConversationData =>
    isRecord(value) && hasString(value.conversation_id) && isRecord(value.mapping);

const isCachedConversationRecord = (value: unknown): value is CachedConversationRecord => {
    if (!isRecord(value)) {
        return false;
    }
    return (
        hasString(value.conversation_id) &&
        (value.provider === 'chatgpt' || value.provider === 'gemini' || value.provider === 'grok' || value.provider === 'unknown') &&
        isConversationDataLike(value.payload) &&
        (value.attempt_id === undefined || isNullableString(value.attempt_id)) &&
        isRecord(value.capture_meta) &&
        isNullableString(value.content_hash) &&
        isFiniteNumber(value.ts) &&
        (value.tab_id === undefined || isFiniteNumber(value.tab_id))
    );
};

const parsePersistedState = (value: unknown): PersistedCacheState | null => {
    if (!isRecord(value)) {
        return null;
    }
    const latestConversationId =
        value.latestConversationId === null || typeof value.latestConversationId === 'string'
            ? value.latestConversationId
            : null;
    if (!Array.isArray(value.records)) {
        return null;
    }
    const records = value.records.filter((candidate): candidate is CachedConversationRecord =>
        isCachedConversationRecord(candidate),
    );
    return { latestConversationId, records };
};

const buildFailureResponse = (
    now: () => number,
    code: ExternalFailureResponse['code'],
    message: string,
): ExternalFailureResponse => ({
    ok: false,
    api: EXTERNAL_API_VERSION,
    code,
    message,
    ts: now(),
});

const providerToPlatformName = (provider: ExternalConversationEvent['provider']): string => {
    if (provider === 'chatgpt') {
        return 'ChatGPT';
    }
    if (provider === 'gemini') {
        return 'Gemini';
    }
    if (provider === 'grok') {
        return 'Grok';
    }
    return 'Unknown';
};

const toFormat = (format: ExternalPullFormat | undefined): ExternalPullFormat => (format === 'common' ? 'common' : 'original');

export const createExternalApiHub = (deps: ExternalApiHubDeps) => {
    const now = deps.now ?? (() => Date.now());
    const maxCachedConversations = deps.maxCachedConversations ?? DEFAULT_MAX_CACHED_CONVERSATIONS;
    const storageKey = deps.storageKey ?? DEFAULT_STORAGE_KEY;
    const recordsByConversation = new Map<string, CachedConversationRecord>();
    const subscribers = new Set<ExternalPortLike>();

    let latestConversationId: string | null = null;
    let hydrated = false;
    let hydrationPromise: Promise<void> | null = null;

    const removeSubscriber = (port: ExternalPortLike) => {
        subscribers.delete(port);
    };

    const ensureHydrated = async () => {
        if (hydrated) {
            return;
        }
        if (hydrationPromise) {
            await hydrationPromise;
            return;
        }
        hydrationPromise = deps.storage
            .get(storageKey)
            .then((result) => {
                const persisted = parsePersistedState(result[storageKey]);
                if (!persisted) {
                    return;
                }
                latestConversationId = persisted.latestConversationId;
                for (const record of persisted.records) {
                    setBoundedMapValue(recordsByConversation, record.conversation_id, record, maxCachedConversations);
                }
            })
            .catch(() => {})
            .finally(() => {
                hydrated = true;
                hydrationPromise = null;
            });
        await hydrationPromise;
    };

    const persist = async () => {
        const state: PersistedCacheState = {
            latestConversationId,
            records: [...recordsByConversation.values()],
        };
        try {
            await deps.storage.set({ [storageKey]: state });
        } catch {}
    };

    const buildSuccessResponse = (
        record: CachedConversationRecord,
        format: ExternalPullFormat,
    ): ExternalConversationSuccessResponse => {
        if (format === 'common') {
            return {
                ok: true,
                api: EXTERNAL_API_VERSION,
                ts: now(),
                conversation_id: record.conversation_id,
                format: 'common',
                data: buildCommonExport(record.payload, providerToPlatformName(record.provider)),
            };
        }
        return {
            ok: true,
            api: EXTERNAL_API_VERSION,
            ts: now(),
            conversation_id: record.conversation_id,
            format: 'original',
            data: record.payload,
        };
    };

    const broadcast = (event: ExternalConversationEvent) => {
        for (const port of [...subscribers]) {
            try {
                port.postMessage(event);
            } catch {
                subscribers.delete(port);
            }
        }
    };

    const addSubscriber = (port: ExternalPortLike): boolean => {
        if (port.name !== EXTERNAL_EVENTS_PORT_NAME) {
            try {
                port.disconnect?.();
            } catch {}
            return false;
        }
        subscribers.add(port);
        const disconnectHandler = () => {
            removeSubscriber(port);
            port.onDisconnect.removeListener?.(disconnectHandler);
        };
        port.onDisconnect.addListener(disconnectHandler);
        return true;
    };

    const ingestEvent = async (event: ExternalConversationEvent, senderTabId?: number) => {
        await ensureHydrated();
        const resolvedTabId = event.tab_id ?? (typeof senderTabId === 'number' ? senderTabId : undefined);
        const enrichedEvent: ExternalConversationEvent =
            resolvedTabId === undefined ? event : { ...event, tab_id: resolvedTabId };

        const record: CachedConversationRecord = {
            conversation_id: enrichedEvent.conversation_id,
            provider: enrichedEvent.provider,
            payload: enrichedEvent.payload,
            attempt_id: enrichedEvent.attempt_id,
            capture_meta: enrichedEvent.capture_meta,
            content_hash: enrichedEvent.content_hash,
            ts: enrichedEvent.ts,
            tab_id: enrichedEvent.tab_id,
        };
        setBoundedMapValue(recordsByConversation, enrichedEvent.conversation_id, record, maxCachedConversations);
        latestConversationId = enrichedEvent.conversation_id;
        await persist();
        broadcast(enrichedEvent);
    };

    const handleExternalRequest = async (request: unknown): Promise<ExternalResponse> => {
        await ensureHydrated();
        if (!isExternalRequest(request)) {
            return buildFailureResponse(now, 'INVALID_REQUEST', 'Invalid external API request');
        }

        if (request.type === 'health.ping') {
            const response: ExternalHealthSuccessResponse = {
                ok: true,
                api: EXTERNAL_API_VERSION,
                ts: now(),
            };
            return response;
        }

        if (request.type === 'conversation.getLatest') {
            if (!latestConversationId) {
                return buildFailureResponse(now, 'UNAVAILABLE', 'No conversation data available');
            }
            const record = recordsByConversation.get(latestConversationId);
            if (!record) {
                return buildFailureResponse(now, 'UNAVAILABLE', 'No conversation data available');
            }
            return buildSuccessResponse(record, toFormat(request.format));
        }

        const record = recordsByConversation.get(request.conversation_id);
        if (!record) {
            return buildFailureResponse(now, 'NOT_FOUND', 'Conversation not found');
        }
        return buildSuccessResponse(record, toFormat(request.format));
    };

    return {
        addSubscriber,
        removeSubscriber,
        ingestEvent,
        handleExternalRequest,
        ensureHydrated,
    };
};
