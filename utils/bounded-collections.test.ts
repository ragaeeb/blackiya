import { describe, expect, it } from 'bun:test';
import { addBoundedSetValue, setBoundedMapValue } from '@/utils/bounded-collections';

describe('bounded-collections', () => {
    describe('setBoundedMapValue', () => {
        it('should return early if maxEntries is 0', () => {
            const map = new Map();
            setBoundedMapValue(map, 'k', 'v', 0);
            expect(map.size).toBe(0);
        });

        it('should set value and keep below maxEntries', () => {
            const map = new Map();
            setBoundedMapValue(map, 'k1', 'v1', 2);
            setBoundedMapValue(map, 'k2', 'v2', 2);
            setBoundedMapValue(map, 'k3', 'v3', 2);

            expect(map.size).toBe(2);
            expect(map.has('k1')).toBeFalse();
            expect(map.get('k2')).toBe('v2');
            expect(map.get('k3')).toBe('v3');
        });

        it('should refresh order on set', () => {
            const map = new Map();
            setBoundedMapValue(map, 'k1', 'v1', 3);
            setBoundedMapValue(map, 'k2', 'v2', 3);
            setBoundedMapValue(map, 'k1', 'v1-new', 3); // Refresh k1
            setBoundedMapValue(map, 'k3', 'v3', 3);
            setBoundedMapValue(map, 'k4', 'v4', 3);

            expect(map.size).toBe(3);
            expect(map.has('k2')).toBeFalse(); // k2 evicted
            expect(map.get('k1')).toBe('v1-new'); // k1 kept
        });
    });

    describe('addBoundedSetValue', () => {
        it('should return early if maxEntries is 0', () => {
            const set = new Set();
            addBoundedSetValue(set, 'k', 0);
            expect(set.size).toBe(0);
        });

        it('should add value and keep below maxEntries', () => {
            const set = new Set();
            addBoundedSetValue(set, 'v1', 2);
            addBoundedSetValue(set, 'v2', 2);
            addBoundedSetValue(set, 'v3', 2);

            expect(set.size).toBe(2);
            expect(set.has('v1')).toBeFalse();
            expect(set.has('v2')).toBeTrue();
            expect(set.has('v3')).toBeTrue();
        });

        it('should not refresh order if existing', () => {
            const set = new Set();
            addBoundedSetValue(set, 'v1', 3);
            addBoundedSetValue(set, 'v2', 3);
            addBoundedSetValue(set, 'v1', 3); // No refresh for sets
            addBoundedSetValue(set, 'v3', 3);
            addBoundedSetValue(set, 'v4', 3);

            expect(set.size).toBe(3);
            expect(set.has('v1')).toBeFalse(); // v1 evicted
            expect(set.has('v2')).toBeTrue();
        });
    });
});
