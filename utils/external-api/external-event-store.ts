import type { ExternalEventStore } from '@/utils/external-api/background-hub-types';
import type { ExternalConversationEvent, ExternalInboundConversationEvent } from '@/utils/external-api/contracts';

type ExternalMetaRecord<T = unknown> = {
    key: string;
    value: T;
};

const DEFAULT_KEEP_COMMITTED_DIAGNOSTIC_EVENTS = 500;
const DEFAULT_MAX_TOTAL_EVENTS = 20_000;
const DEFAULT_COMMITTED_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export const createInMemoryExternalEventStore = (deps?: {
    now?: () => number;
    maxTotalEvents?: number;
    keepCommittedDiagnostics?: number;
    committedTtlMs?: number;
}): ExternalEventStore => {
    const now = deps?.now ?? (() => Date.now());
    const maxTotalEvents = deps?.maxTotalEvents ?? DEFAULT_MAX_TOTAL_EVENTS;
    const keepCommittedDiagnostics = deps?.keepCommittedDiagnostics ?? DEFAULT_KEEP_COMMITTED_DIAGNOSTIC_EVENTS;
    const committedTtlMs = deps?.committedTtlMs ?? DEFAULT_COMMITTED_TTL_MS;

    const events: ExternalConversationEvent[] = [];
    let nextSeq = 1;
    let deliveryConsumerId: string | null = null;
    const committedByConsumer = new Map<string, number>();
    let lastWakeSentAt = 0;

    const findByEventId = (eventId: string) => events.find((event) => event.event_id === eventId) ?? null;

    const getCommittedCursor = (): number => {
        if (!deliveryConsumerId) {
            return 0;
        }
        return committedByConsumer.get(deliveryConsumerId) ?? 0;
    };

    return {
        init: async () => {},
        append: async (event) => {
            const existing = findByEventId(event.event_id);
            if (existing) {
                return existing;
            }
            const created = {
                ...event,
                seq: nextSeq,
                created_at: now(),
            } satisfies ExternalConversationEvent;
            nextSeq += 1;
            events.push(created);
            return created;
        },
        getSince: async (cursor, limit) =>
            events.filter((event) => event.seq > cursor).slice(0, Math.max(1, Math.floor(limit))),
        getHeadSeq: async () => events[events.length - 1]?.seq ?? 0,
        getLatest: async (tabId) => {
            if (typeof tabId !== 'number') {
                return events[events.length - 1] ?? null;
            }
            for (let index = events.length - 1; index >= 0; index -= 1) {
                if (events[index]?.tab_id === tabId) {
                    return events[index] ?? null;
                }
            }
            return null;
        },
        getByConversationId: async (conversationId) => {
            for (let index = events.length - 1; index >= 0; index -= 1) {
                if (events[index]?.conversation_id === conversationId) {
                    return events[index] ?? null;
                }
            }
            return null;
        },
        ensureDeliveryConsumer: async (consumerId) => {
            if (!deliveryConsumerId) {
                deliveryConsumerId = consumerId;
            }
            return {
                designatedConsumerId: deliveryConsumerId,
                authorized: deliveryConsumerId === consumerId,
            };
        },
        getDeliveryConsumerId: async () => deliveryConsumerId,
        commit: async (consumerId, upToSeq) => {
            if (!deliveryConsumerId || deliveryConsumerId !== consumerId) {
                return {
                    committedSeq: getCommittedCursor(),
                    authorized: false,
                };
            }
            const headSeq = events[events.length - 1]?.seq ?? 0;
            const bounded = Math.max(0, Math.min(Math.floor(upToSeq), headSeq));
            const existing = committedByConsumer.get(consumerId) ?? 0;
            const committedSeq = Math.max(existing, bounded);
            committedByConsumer.set(consumerId, committedSeq);
            return {
                committedSeq,
                authorized: true,
            };
        },
        prune: async () => {
            const committedUpToSeq = getCommittedCursor();
            const keepFromSeq = Math.max(1, committedUpToSeq - keepCommittedDiagnostics + 1);
            const ttlBoundary = now() - committedTtlMs;
            let deleted = 0;

            let index = 0;
            while (index < events.length) {
                const event = events[index];
                if (!event || event.seq > committedUpToSeq) {
                    index += 1;
                    continue;
                }
                const canRemoveByWindow = event.seq < keepFromSeq;
                const canRemoveByTtl = event.created_at < ttlBoundary;
                const canRemoveByCap = events.length > maxTotalEvents;
                if (canRemoveByWindow || canRemoveByTtl || canRemoveByCap) {
                    events.splice(index, 1);
                    deleted += 1;
                    continue;
                }
                index += 1;
            }

            const blockedByUncommitted = events.length > maxTotalEvents;
            return {
                deleted,
                total: events.length,
                blockedByUncommitted,
            };
        },
        getLastWakeSentAt: async () => lastWakeSentAt,
        setLastWakeSentAt: async (ts) => {
            lastWakeSentAt = ts;
        },
    };
};

type IndexedDbStoreDeps = {
    dbName?: string;
    now?: () => number;
    maxTotalEvents?: number;
    keepCommittedDiagnostics?: number;
    committedTtlMs?: number;
};

const IDB_EVENTS_STORE = 'externalEvents';
const IDB_META_STORE = 'externalMeta';
const META_NEXT_SEQ = 'next_seq';
const META_DELIVERY_CONSUMER_ID = 'delivery_consumer_id';
const META_COMMITTED_MAP = 'committed_up_to_seq_by_consumer';
const META_LAST_WAKE_SENT_AT = 'last_wake_sent_at';

const requestAsPromise = <T>(request: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
    });

const transactionComplete = (transaction: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('indexedDB transaction failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('indexedDB transaction aborted'));
    });

const openDatabase = (dbName: string) =>
    new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('indexedDB is unavailable'));
            return;
        }
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(IDB_EVENTS_STORE)) {
                const eventsStore = database.createObjectStore(IDB_EVENTS_STORE, { keyPath: 'seq' });
                eventsStore.createIndex('by_event_id', 'event_id', { unique: true });
                eventsStore.createIndex('by_created_at', 'created_at', { unique: false });
                eventsStore.createIndex('by_conversation_id', 'conversation_id', { unique: false });
            }
            if (!database.objectStoreNames.contains(IDB_META_STORE)) {
                database.createObjectStore(IDB_META_STORE, { keyPath: 'key' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('failed to open indexedDB'));
    });

const coerceCommittedMap = (value: unknown): Record<string, number> => {
    if (!value || typeof value !== 'object') {
        return {};
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, seq]) => typeof seq === 'number' && Number.isFinite(seq))
        .map(([consumerId, seq]) => [consumerId, Math.max(0, Math.floor(seq as number))] as const);
    return Object.fromEntries(entries);
};

const coerceNumber = (value: unknown, fallback = 0) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const coerceStringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export const createIndexedDbExternalEventStore = (deps?: IndexedDbStoreDeps): ExternalEventStore => {
    const dbName = deps?.dbName ?? 'blackiya_external_events_v1';
    const now = deps?.now ?? (() => Date.now());
    const maxTotalEvents = deps?.maxTotalEvents ?? DEFAULT_MAX_TOTAL_EVENTS;
    const keepCommittedDiagnostics = deps?.keepCommittedDiagnostics ?? DEFAULT_KEEP_COMMITTED_DIAGNOSTIC_EVENTS;
    const committedTtlMs = deps?.committedTtlMs ?? DEFAULT_COMMITTED_TTL_MS;

    let dbPromise: Promise<IDBDatabase> | null = null;

    const getDb = async () => {
        if (!dbPromise) {
            dbPromise = openDatabase(dbName);
        }
        return dbPromise;
    };

    const getMetaValue = async <T>(key: string, fallback: T): Promise<T> => {
        const db = await getDb();
        const transaction = db.transaction(IDB_META_STORE, 'readonly');
        const store = transaction.objectStore(IDB_META_STORE);
        const record = (await requestAsPromise(store.get(key))) as ExternalMetaRecord<T> | undefined;
        await transactionComplete(transaction);
        if (!record || !('value' in record)) {
            return fallback;
        }
        return record.value;
    };

    const setMetaValue = async <T>(key: string, value: T) => {
        const db = await getDb();
        const transaction = db.transaction(IDB_META_STORE, 'readwrite');
        const store = transaction.objectStore(IDB_META_STORE);
        store.put({ key, value } satisfies ExternalMetaRecord<T>);
        await transactionComplete(transaction);
    };

    const getHeadSeq = async () => {
        const db = await getDb();
        const transaction = db.transaction(IDB_EVENTS_STORE, 'readonly');
        const store = transaction.objectStore(IDB_EVENTS_STORE);
        const cursor = await requestAsPromise(store.openCursor(null, 'prev'));
        await transactionComplete(transaction);
        return (cursor?.value as ExternalConversationEvent | undefined)?.seq ?? 0;
    };

    const getCommittedCursor = async () => {
        const deliveryConsumerId = coerceStringOrNull(await getMetaValue(META_DELIVERY_CONSUMER_ID, null));
        if (!deliveryConsumerId) {
            return 0;
        }
        const committedMap = coerceCommittedMap(await getMetaValue(META_COMMITTED_MAP, {}));
        return committedMap[deliveryConsumerId] ?? 0;
    };

    return {
        init: async () => {
            await getDb();
        },
        append: async (event: ExternalInboundConversationEvent) => {
            const db = await getDb();

            {
                const existingTx = db.transaction(IDB_EVENTS_STORE, 'readonly');
                const existingIndex = existingTx.objectStore(IDB_EVENTS_STORE).index('by_event_id');
                const existing = (await requestAsPromise(existingIndex.get(event.event_id))) as
                    | ExternalConversationEvent
                    | undefined;
                await transactionComplete(existingTx);
                if (existing) {
                    return existing;
                }
            }

            const transaction = db.transaction([IDB_EVENTS_STORE, IDB_META_STORE], 'readwrite');
            const eventsStore = transaction.objectStore(IDB_EVENTS_STORE);
            const metaStore = transaction.objectStore(IDB_META_STORE);

            const nextSeqRecord = (await requestAsPromise(metaStore.get(META_NEXT_SEQ))) as
                | ExternalMetaRecord<number>
                | undefined;
            const nextSeq = coerceNumber(nextSeqRecord?.value, 1);
            const created = {
                ...event,
                seq: nextSeq,
                created_at: now(),
            } satisfies ExternalConversationEvent;

            eventsStore.put(created);
            metaStore.put({ key: META_NEXT_SEQ, value: nextSeq + 1 } satisfies ExternalMetaRecord<number>);
            await transactionComplete(transaction);
            return created;
        },
        getSince: async (cursor, limit) => {
            const boundedLimit = Math.max(1, Math.floor(limit));
            const db = await getDb();
            const transaction = db.transaction(IDB_EVENTS_STORE, 'readonly');
            const store = transaction.objectStore(IDB_EVENTS_STORE);
            const range = IDBKeyRange.lowerBound(Math.max(0, Math.floor(cursor)) + 1);
            const events: ExternalConversationEvent[] = [];

            await new Promise<void>((resolve, reject) => {
                const request = store.openCursor(range, 'next');
                request.onerror = () => reject(request.error ?? new Error('failed to iterate events'));
                request.onsuccess = () => {
                    const cursorResult = request.result;
                    if (!cursorResult || events.length >= boundedLimit) {
                        resolve();
                        return;
                    }
                    events.push(cursorResult.value as ExternalConversationEvent);
                    cursorResult.continue();
                };
            });
            await transactionComplete(transaction);
            return events;
        },
        getHeadSeq,
        getLatest: async (tabId) => {
            const db = await getDb();
            const transaction = db.transaction(IDB_EVENTS_STORE, 'readonly');
            const store = transaction.objectStore(IDB_EVENTS_STORE);
            if (typeof tabId !== 'number') {
                const cursor = await requestAsPromise(store.openCursor(null, 'prev'));
                await transactionComplete(transaction);
                return (cursor?.value as ExternalConversationEvent | undefined) ?? null;
            }

            let latest: ExternalConversationEvent | null = null;
            await new Promise<void>((resolve, reject) => {
                const request = store.openCursor(null, 'prev');
                request.onerror = () => reject(request.error ?? new Error('failed to iterate latest by tab'));
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) {
                        resolve();
                        return;
                    }
                    const value = cursor.value as ExternalConversationEvent;
                    if (value.tab_id === tabId) {
                        latest = value;
                        resolve();
                        return;
                    }
                    cursor.continue();
                };
            });
            await transactionComplete(transaction);
            return latest;
        },
        getByConversationId: async (conversationId) => {
            const db = await getDb();
            const transaction = db.transaction(IDB_EVENTS_STORE, 'readonly');
            const index = transaction.objectStore(IDB_EVENTS_STORE).index('by_conversation_id');
            const cursor = await requestAsPromise(index.openCursor(IDBKeyRange.only(conversationId), 'prev'));
            await transactionComplete(transaction);
            return (cursor?.value as ExternalConversationEvent | undefined) ?? null;
        },
        ensureDeliveryConsumer: async (consumerId) => {
            const designated = coerceStringOrNull(await getMetaValue(META_DELIVERY_CONSUMER_ID, null));
            if (!designated) {
                await setMetaValue(META_DELIVERY_CONSUMER_ID, consumerId);
                return {
                    designatedConsumerId: consumerId,
                    authorized: true,
                };
            }
            return {
                designatedConsumerId: designated,
                authorized: designated === consumerId,
            };
        },
        getDeliveryConsumerId: async () => coerceStringOrNull(await getMetaValue(META_DELIVERY_CONSUMER_ID, null)),
        commit: async (consumerId, upToSeq) => {
            const designated = coerceStringOrNull(await getMetaValue(META_DELIVERY_CONSUMER_ID, null));
            if (!designated || designated !== consumerId) {
                return {
                    committedSeq: await getCommittedCursor(),
                    authorized: false,
                };
            }

            const committedMap = coerceCommittedMap(await getMetaValue(META_COMMITTED_MAP, {}));
            const headSeq = await getHeadSeq();
            const bounded = Math.max(0, Math.min(Math.floor(upToSeq), headSeq));
            const existing = committedMap[consumerId] ?? 0;
            const committedSeq = Math.max(existing, bounded);
            committedMap[consumerId] = committedSeq;
            await setMetaValue(META_COMMITTED_MAP, committedMap);
            return {
                committedSeq,
                authorized: true,
            };
        },
        prune: async () => {
            const committedUpToSeq = await getCommittedCursor();
            const keepFromSeq = Math.max(1, committedUpToSeq - keepCommittedDiagnostics + 1);
            const ttlBoundary = now() - committedTtlMs;
            const db = await getDb();
            const transaction = db.transaction(IDB_EVENTS_STORE, 'readwrite');
            const store = transaction.objectStore(IDB_EVENTS_STORE);
            const count = (await requestAsPromise(store.count())) as number;
            let remainingTotal = count;
            let deleted = 0;

            await new Promise<void>((resolve, reject) => {
                const request = store.openCursor(null, 'next');
                request.onerror = () => reject(request.error ?? new Error('failed to prune event store'));
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) {
                        resolve();
                        return;
                    }
                    const event = cursor.value as ExternalConversationEvent;
                    if (event.seq > committedUpToSeq) {
                        cursor.continue();
                        return;
                    }
                    const canRemoveByWindow = event.seq < keepFromSeq;
                    const canRemoveByTtl = event.created_at < ttlBoundary;
                    const canRemoveByCap = remainingTotal > maxTotalEvents;
                    if (canRemoveByWindow || canRemoveByTtl || canRemoveByCap) {
                        cursor.delete();
                        deleted += 1;
                        remainingTotal -= 1;
                    }
                    cursor.continue();
                };
            });

            await transactionComplete(transaction);
            const blockedByUncommitted = remainingTotal > maxTotalEvents;
            return {
                deleted,
                total: remainingTotal,
                blockedByUncommitted,
            };
        },
        getLastWakeSentAt: async () => coerceNumber(await getMetaValue(META_LAST_WAKE_SENT_AT, 0), 0),
        setLastWakeSentAt: async (ts) => {
            await setMetaValue(META_LAST_WAKE_SENT_AT, Math.max(0, Math.floor(ts)));
        },
    };
};
