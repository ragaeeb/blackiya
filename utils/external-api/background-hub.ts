import { setBoundedMapValue } from '@/utils/bounded-collections';
import { buildCommonExport } from '@/utils/common-export';
import { EXTERNAL_CACHE_STORAGE_KEY } from '@/utils/external-api/constants';
import type {
    ExternalConversationEvent,
    ExternalConversationSuccessResponse,
    ExternalFailureResponse,
    ExternalHealthSuccessResponse,
    ExternalPullFormat,
    ExternalResponse,
} from '@/utils/external-api/contracts';
import {
    EXTERNAL_API_VERSION,
    EXTERNAL_EVENTS_PORT_NAME,
    isConversationDataLike,
    isExportMeta,
    isExternalRequest,
} from '@/utils/external-api/contracts';
import { hasString, isFiniteNumber, isNullableString, isRecord } from '@/utils/type-guards';
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

export type CachedConversationRecord = {
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
    persistDebounceMs?: number;
    logger?: {
        warn: (message: string, data?: unknown) => void;
    };
};

const DEFAULT_MAX_CACHED_CONVERSATIONS = 50;
const DEFAULT_PERSIST_DEBOUNCE_MS = 500;

const isQuotaError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const normalized = message.toLowerCase();
    return normalized.includes('quota') || normalized.includes('quota_bytes');
};

const isCachedConversationRecord = (value: unknown): value is CachedConversationRecord => {
    if (!isRecord(value)) {
        return false;
    }
    return (
        hasString(value.conversation_id) &&
        (value.provider === 'chatgpt' ||
            value.provider === 'gemini' ||
            value.provider === 'grok' ||
            value.provider === 'unknown') &&
        isConversationDataLike(value.payload) &&
        (value.attempt_id === undefined || isNullableString(value.attempt_id)) &&
        isExportMeta(value.capture_meta) &&
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

const toFormat = (format: ExternalPullFormat | undefined): ExternalPullFormat =>
    format === 'common' ? 'common' : 'original';

export const createExternalApiHub = (deps: ExternalApiHubDeps) => {
    const now = deps.now ?? (() => Date.now());
    const maxCachedConversations = deps.maxCachedConversations ?? DEFAULT_MAX_CACHED_CONVERSATIONS;
    const storageKey = deps.storageKey ?? EXTERNAL_CACHE_STORAGE_KEY;
    const persistDebounceMs = deps.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
    const recordsByConversation = new Map<string, CachedConversationRecord>();
    const subscribers = new Set<ExternalPortLike>();

    let latestConversationId: string | null = null;
    let hydrated = false;
    let hydrationPromise: Promise<void> | null = null;
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    let persistInFlight: Promise<void> | null = null;

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
            .catch((error) => {
                deps.logger?.warn('Failed to hydrate external API cache from storage', { error });
            })
            .finally(() => {
                hydrated = true;
                hydrationPromise = null;
            });
        await hydrationPromise;
    };

    const resolveLatestConversationIdForRecords = (records: CachedConversationRecord[]): string | null => {
        if (latestConversationId && records.some((record) => record.conversation_id === latestConversationId)) {
            return latestConversationId;
        }
        return records[records.length - 1]?.conversation_id ?? null;
    };

    const persistState = async (records: CachedConversationRecord[]) => {
        const state: PersistedCacheState = {
            latestConversationId: resolveLatestConversationIdForRecords(records),
            records,
        };
        await deps.storage.set({ [storageKey]: state });
    };

    const persist = async () => {
        const allRecords = [...recordsByConversation.values()];
        let droppedRecords = 0;

        // Progressive shed strategy: on quota errors we increase `droppedRecords` so
        // `allRecords.slice(droppedRecords)` drops oldest records, recomputes
        // `latestConversationId` for the reduced snapshot, and retries. We run up to
        // n+1 attempts (where n is `allRecords.length`) so the final iteration can
        // still persist an empty state.
        while (droppedRecords <= allRecords.length) {
            const records = allRecords.slice(droppedRecords);
            try {
                await persistState(records);
                return;
            } catch (error) {
                if (!isQuotaError(error)) {
                    deps.logger?.warn('Failed to persist external API cache to storage', {
                        error,
                        attemptedRecordCount: records.length,
                    });
                    return;
                }
                droppedRecords += 1;
                if (droppedRecords > allRecords.length) {
                    deps.logger?.warn('Failed to persist external API cache after quota retries', {
                        error,
                        attemptedRecordCount: records.length,
                    });
                    return;
                }
            }
        }
    };

    const runPersistNow = async () => {
        if (persistInFlight) {
            await persistInFlight;
            return;
        }
        persistInFlight = persist().finally(() => {
            persistInFlight = null;
        });
        await persistInFlight;
    };

    const debouncedPersist = () => {
        if (persistDebounceMs <= 0) {
            void runPersistNow();
            return;
        }
        if (persistTimer !== null) {
            clearTimeout(persistTimer);
        }
        persistTimer = setTimeout(() => {
            persistTimer = null;
            void runPersistNow();
        }, persistDebounceMs);
    };

    const flushPersist = async () => {
        if (persistTimer !== null) {
            clearTimeout(persistTimer);
            persistTimer = null;
        }
        await runPersistNow();
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

    const resolveLatestRecordForTab = (tabId: number): CachedConversationRecord | null => {
        let latestForTab: CachedConversationRecord | null = null;
        for (const record of recordsByConversation.values()) {
            if (record.tab_id !== tabId) {
                continue;
            }
            if (!latestForTab || record.ts > latestForTab.ts) {
                latestForTab = record;
            }
        }
        return latestForTab;
    };

    const resolveCurrentLatestRecord = (): CachedConversationRecord | null => {
        if (latestConversationId) {
            const latestRecord = recordsByConversation.get(latestConversationId);
            if (latestRecord) {
                return latestRecord;
            }
        }

        let fallbackLatest: CachedConversationRecord | null = null;
        for (const record of recordsByConversation.values()) {
            if (!fallbackLatest || record.ts > fallbackLatest.ts) {
                fallbackLatest = record;
            }
        }
        latestConversationId = fallbackLatest?.conversation_id ?? null;
        return fallbackLatest;
    };

    const resolveAndUpdateLatestRecord = (tabId?: number): CachedConversationRecord | null => {
        if (typeof tabId === 'number') {
            return resolveLatestRecordForTab(tabId);
        }
        return resolveCurrentLatestRecord();
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
        debouncedPersist();
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
            const record = resolveAndUpdateLatestRecord(request.tab_id);
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
        flushPersist,
    };
};
