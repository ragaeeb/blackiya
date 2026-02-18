import { describe, expect, it } from 'bun:test';
import { LRUCache } from './lru-cache';

describe('LRUCache', () => {
    it('should store and retrieve values', () => {
        const cache = new LRUCache<string, number>(3);
        cache.set('a', 1);
        expect(cache.get('a')).toBe(1);
    });

    it('should evict oldest item when overflow occurs', () => {
        const cache = new LRUCache<string, number>(2);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3); // Should evict 'a'

        expect(cache.has('a')).toBeFalse();
        expect(cache.get('b')).toBe(2);
        expect(cache.get('c')).toBe(3);
        expect(cache.size).toBe(2);
    });

    it('should refresh item position on access (get)', () => {
        const cache = new LRUCache<string, number>(2);
        cache.set('a', 1);
        cache.set('b', 2);

        // Access 'a', making 'b' the oldest
        cache.get('a');

        cache.set('c', 3); // Should evict 'b'

        expect(cache.has('b')).toBeFalse();
        expect(cache.has('a')).toBeTrue();
        expect(cache.has('c')).toBeTrue();
    });

    it('should refresh item position on update (set)', () => {
        const cache = new LRUCache<string, number>(2);
        cache.set('a', 1);
        cache.set('b', 2);

        // Update 'a', making 'b' the oldest
        cache.set('a', 10);

        cache.set('c', 3); // Should evict 'b'

        expect(cache.has('b')).toBeFalse();
        expect(cache.get('a')).toBe(10);
        expect(cache.get('c')).toBe(3);
    });

    it('should throw error for invalid size', () => {
        expect(() => new LRUCache(0)).toThrow();
        expect(() => new LRUCache(-1)).toThrow();
    });

    it('should support clearing the cache', () => {
        const cache = new LRUCache<string, number>(3);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.clear();
        expect(cache.size).toBe(0);
        expect(cache.has('a')).toBeFalse();
    });
});
