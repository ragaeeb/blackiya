/**
 * LRU Cache Implementation
 *
 * A generic Least Recently Used cache with a fixed size limit.
 * Used to managed memory usage for conversation caches in long-running sessions.
 */
export class LRUCache<K, V> {
    private cache = new Map<K, V>();
    private readonly maxSize: number;

    constructor(maxSize: number) {
        if (maxSize <= 0) {
            throw new Error('LRUCache max size must be greater than 0');
        }
        this.maxSize = maxSize;
    }

    get(key: K): V | undefined {
        if (!this.cache.has(key)) {
            return undefined;
        }

        // Refresh item position (delete and re-add)
        const value = this.cache.get(key) as V;
        this.cache.delete(key);
        this.cache.set(key, value);

        return value;
    }

    set(key: K, value: V): void {
        if (this.cache.has(key)) {
            // If exists, refresh position
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // Evict oldest (first item in Map)
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey !== undefined) {
                this.cache.delete(oldestKey);
            }
        }

        this.cache.set(key, value);
    }

    has(key: K): boolean {
        return this.cache.has(key);
    }

    delete(key: K): boolean {
        return this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }

    get size(): number {
        return this.cache.size;
    }

    keys(): IterableIterator<K> {
        return this.cache.keys();
    }

    values(): IterableIterator<V> {
        return this.cache.values();
    }
}
