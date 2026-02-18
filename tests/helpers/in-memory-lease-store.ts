import type { ProbeLeaseCoordinatorStore } from '@/utils/sfe/probe-lease-coordinator';

export class InMemoryLeaseStore implements ProbeLeaseCoordinatorStore {
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
        return Object.fromEntries(this.entries);
    }
}
