export function setBoundedMapValue<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
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
}

export function addBoundedSetValue<T>(set: Set<T>, value: T, maxEntries: number): void {
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
}
