import type { ProbeLeaseCoordinatorStore } from '@/utils/sfe/probe-lease-coordinator';

export class SessionStorageProbeLeaseStore implements ProbeLeaseCoordinatorStore {
    private readonly storage: typeof browser.storage.session;

    public constructor(storage: typeof browser.storage.session) {
        this.storage = storage;
    }

    public async get(key: string) {
        const result = await this.storage.get(key);
        const value = result[key];
        return typeof value === 'string' ? value : null;
    }

    public async set(key: string, value: string) {
        await this.storage.set({ [key]: value });
    }

    public async remove(key: string) {
        await this.storage.remove(key);
    }

    public async getAll() {
        const result = await this.storage.get(null);
        const output: Record<string, string> = {};
        for (const [key, value] of Object.entries(result)) {
            if (typeof value === 'string') {
                output[key] = value;
            }
        }
        return output;
    }
}

export class InMemoryProbeLeaseStore implements ProbeLeaseCoordinatorStore {
    private readonly entries = new Map<string, string>();

    public async get(key: string) {
        return this.entries.get(key) ?? null;
    }

    public async set(key: string, value: string) {
        this.entries.set(key, value);
    }

    public async remove(key: string) {
        this.entries.delete(key);
    }

    public async getAll() {
        return Object.fromEntries(this.entries.entries());
    }
}

export const createProbeLeaseStore = (): ProbeLeaseCoordinatorStore => {
    const sessionStorage = (globalThis as { browser?: { storage?: { session?: typeof browser.storage.session } } })
        .browser?.storage?.session;
    if (sessionStorage) {
        return new SessionStorageProbeLeaseStore(sessionStorage);
    }
    return new InMemoryProbeLeaseStore();
};
