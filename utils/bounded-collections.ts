/**
 * Inserts or updates {`@link` key} in {`@link` map} (refreshing insertion order)
 * and evicts the oldest entry when size would exceed {`@link` maxEntries}.
 * No-op when maxEntries ≤ 0.
 */
export const setBoundedMapValue = <K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number) => {
    if (maxEntries <= 0) {
        return;
    }

    if (map.has(key)) {
        map.delete(key);
    }
    map.set(key, value);
    while (map.size > maxEntries) {
        const oldest = map.keys().next().value as K | undefined;
        if (oldest === undefined) {
            break;
        }
        map.delete(oldest);
    }
};

/**
 * Promotes an existing map key to most-recent without changing its value.
 * Useful for bounded maps that act as LRU read caches.
 */
export const touchBoundedMapKey = <K, V>(map: Map<K, V>, key: K) => {
    if (!map.has(key)) {
        return false;
    }
    const value = map.get(key) as V;
    map.delete(key);
    map.set(key, value);
    return true;
};

/**
 * Adds {`@link` value} to {`@link` set} if not already present.
 * Existing values are NOT promoted (order is NOT refreshed).
 * Evicts oldest entries when size would exceed {`@link` maxEntries}.
 * No-op when maxEntries ≤ 0.
 */
export const addBoundedSetValue = <T>(set: Set<T>, value: T, maxEntries: number) => {
    if (maxEntries <= 0) {
        return;
    }

    if (set.has(value)) {
        return;
    }
    set.add(value);
    while (set.size > maxEntries) {
        const oldest = set.values().next().value as T | undefined;
        if (oldest === undefined) {
            break;
        }
        set.delete(oldest);
    }
};
