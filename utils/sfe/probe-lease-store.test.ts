import { describe, expect, it, mock } from 'bun:test';
import {
    createProbeLeaseStore,
    InMemoryProbeLeaseStore,
    SessionStorageProbeLeaseStore,
} from '@/utils/sfe/probe-lease-store';

describe('probe-lease-store', () => {
    describe('InMemoryProbeLeaseStore', () => {
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

        it('should return null for a key that has never been set', async () => {
            const store = new InMemoryProbeLeaseStore();
            expect(await store.get('nonexistent')).toBeNull();
        });

        it('should overwrite an existing key on set', async () => {
            const store = new InMemoryProbeLeaseStore();
            await store.set('key', 'first');
            await store.set('key', 'second');
            expect(await store.get('key')).toBe('second');
        });

        it('should be a no-op when removing a key that does not exist', async () => {
            const store = new InMemoryProbeLeaseStore();
            await expect(store.remove('missing')).resolves.toBeUndefined();
        });

        it('should return an empty object when the store is empty', async () => {
            const store = new InMemoryProbeLeaseStore();
            expect(await store.getAll()).toEqual({});
        });
    });

    describe('SessionStorageProbeLeaseStore', () => {
        const buildMockStorage = (initialData: Record<string, unknown> = {}) => {
            const data: Record<string, unknown> = { ...initialData };
            return {
                get: mock(async (key: string | null) => {
                    if (key === null) {
                        return { ...data };
                    }
                    return { [key as string]: data[key as string] };
                }),
                set: mock(async (items: Record<string, unknown>) => {
                    for (const [k, v] of Object.entries(items)) {
                        data[k] = v;
                    }
                }),
                remove: mock(async (key: string) => {
                    delete data[key];
                }),
                data,
            };
        };

        it('should return null when the key is missing in storage', async () => {
            const mockStorage = buildMockStorage();
            const store = new SessionStorageProbeLeaseStore(mockStorage as any);
            expect(await store.get('missing')).toBeNull();
        });

        it('should return null when the stored value is not a string', async () => {
            const mockStorage = buildMockStorage({ numericKey: 42 });
            const store = new SessionStorageProbeLeaseStore(mockStorage as any);
            expect(await store.get('numericKey')).toBeNull();
        });

        it('should return the stored string value', async () => {
            const mockStorage = buildMockStorage({ myKey: 'myValue' });
            const store = new SessionStorageProbeLeaseStore(mockStorage as any);
            expect(await store.get('myKey')).toBe('myValue');
        });

        it('should store a value via set', async () => {
            const mockStorage = buildMockStorage();
            const store = new SessionStorageProbeLeaseStore(mockStorage as any);
            await store.set('k', 'v');
            expect(mockStorage.set).toHaveBeenCalledWith({ k: 'v' });
        });

        it('should remove a key via remove', async () => {
            const mockStorage = buildMockStorage({ k: 'v' });
            const store = new SessionStorageProbeLeaseStore(mockStorage as any);
            await store.remove('k');
            expect(mockStorage.remove).toHaveBeenCalledWith('k');
        });

        it('should return only string values from getAll, filtering out non-strings', async () => {
            const mockStorage = buildMockStorage({ strKey: 'hello', numKey: 99, boolKey: true });
            const store = new SessionStorageProbeLeaseStore(mockStorage as any);
            const all = await store.getAll();
            expect(all).toEqual({ strKey: 'hello' });
        });

        it('should return an empty object from getAll when storage is empty', async () => {
            const mockStorage = buildMockStorage();
            const store = new SessionStorageProbeLeaseStore(mockStorage as any);
            expect(await store.getAll()).toEqual({});
        });
    });

    describe('createProbeLeaseStore', () => {
        it('should return a SessionStorageProbeLeaseStore when browser.storage.session is available', async () => {
            // Provide a minimal browser.storage.session in the global scope
            const stored: Record<string, unknown> = {};
            const originalBrowser = (globalThis as any).browser;
            const fakeBrowser = {
                storage: {
                    session: {
                        get: async (key: string | null) => (key === null ? { ...stored } : { [key]: stored[key] }),
                        set: async (items: Record<string, unknown>) => {
                            Object.assign(stored, items);
                        },
                        remove: async (key: string) => {
                            delete stored[key];
                        },
                    },
                },
            };
            (globalThis as any).browser = fakeBrowser;
            try {
                const store = createProbeLeaseStore();
                expect(store).toBeInstanceOf(SessionStorageProbeLeaseStore);
                await store.set('testKey', 'testVal');
                expect(stored).toEqual({ testKey: 'testVal' });
                expect(await store.get('testKey')).toBe('testVal');
            } finally {
                if (originalBrowser === undefined) {
                    delete (globalThis as any).browser;
                } else {
                    (globalThis as any).browser = originalBrowser;
                }
            }
        });

        it('should return an InMemoryProbeLeaseStore when browser global is absent', async () => {
            const originalBrowser = (globalThis as any).browser;
            delete (globalThis as any).browser;
            try {
                const store = createProbeLeaseStore();
                expect(store).toBeInstanceOf(InMemoryProbeLeaseStore);
                await store.set('x', '1');
                expect(await store.get('x')).toBe('1');
            } finally {
                if (originalBrowser === undefined) {
                    delete (globalThis as any).browser;
                } else {
                    (globalThis as any).browser = originalBrowser;
                }
            }
        });
    });
});
