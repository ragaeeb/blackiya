import type { ProbeLeaseCoordinatorStore } from '@/utils/sfe/probe-lease-coordinator';

export class InMemoryLeaseStore implements ProbeLeaseCoordinatorStore {
    private readonly entries = new Map<string, string>();

    public async get(key: string): Promise<string | null> {
        return this.entries.get(key) ?? null;
    }

    public async set(key: string, value: string): Promise<void> {
        this.entries.set(key, value);
    }

    public async remove(key: string): Promise<void> {
        this.entries.delete(key);
    }

    public async getAll(): Promise<Record<string, string>> {
        return Object.fromEntries(this.entries.entries());
    }
}
