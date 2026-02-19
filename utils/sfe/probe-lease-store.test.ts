import { describe, expect, it } from 'bun:test';
import { InMemoryProbeLeaseStore } from '@/utils/sfe/probe-lease-store';

describe('probe-lease-store', () => {
    it('should support get/set/remove round-trip for in-memory store', async () => {
        const store = new InMemoryProbeLeaseStore();
        expect(await store.get('k1')).toBeNull();

        await store.set('k1', 'v1');
        expect(await store.get('k1')).toBe('v1');

        await store.remove('k1');
        expect(await store.get('k1')).toBeNull();
    });

    it('should expose all key/value entries from in-memory store', async () => {
        const store = new InMemoryProbeLeaseStore();
        await store.set('a', '1');
        await store.set('b', '2');

        const all = await store.getAll();
        expect(all).toEqual({ a: '1', b: '2' });
    });
});
