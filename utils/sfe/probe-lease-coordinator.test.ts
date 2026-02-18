import { describe, expect, it } from 'bun:test';
import { ProbeLeaseCoordinator, type ProbeLeaseCoordinatorStore } from '@/utils/sfe/probe-lease-coordinator';

class InMemoryLeaseStore implements ProbeLeaseCoordinatorStore {
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

describe('ProbeLeaseCoordinator', () => {
    it('blocks claim while owner is unexpired and allows takeover after expiry', async () => {
        const store = new InMemoryLeaseStore();
        let now = 1_000;
        const coordinator = new ProbeLeaseCoordinator({
            store,
            now: () => now,
        });

        const first = await coordinator.claim('conv-1', 'attempt-a', 5_000);
        expect(first.acquired).toBe(true);
        expect(first.ownerAttemptId).toBe('attempt-a');

        const blocked = await coordinator.claim('conv-1', 'attempt-b', 5_000);
        expect(blocked.acquired).toBe(false);
        expect(blocked.ownerAttemptId).toBe('attempt-a');

        now = 7_000;
        const takeover = await coordinator.claim('conv-1', 'attempt-b', 3_000);
        expect(takeover.acquired).toBe(true);
        expect(takeover.ownerAttemptId).toBe('attempt-b');
    });

    it('enforces owner-only release and idempotent release', async () => {
        const store = new InMemoryLeaseStore();
        const coordinator = new ProbeLeaseCoordinator({ store, now: () => 10_000 });

        await coordinator.claim('conv-2', 'attempt-a', 5_000);

        expect(await coordinator.release('conv-2', 'attempt-b')).toBe(false);
        expect(await coordinator.release('conv-2', 'attempt-a')).toBe(true);
        expect(await coordinator.release('conv-2', 'attempt-a')).toBe(false);
    });

    it('hydrates from store and prunes expired records', async () => {
        const store = new InMemoryLeaseStore();
        const now = 20_000;
        const prefix = 'test-lease:';
        await store.set(
            `${prefix}conv-valid`,
            JSON.stringify({
                attemptId: 'attempt-valid',
                expiresAtMs: now + 5_000,
                updatedAtMs: now - 100,
            }),
        );
        await store.set(
            `${prefix}conv-expired`,
            JSON.stringify({
                attemptId: 'attempt-expired',
                expiresAtMs: now - 100,
                updatedAtMs: now - 1_000,
            }),
        );

        const coordinator = new ProbeLeaseCoordinator({
            store,
            now: () => now,
            keyPrefix: prefix,
        });

        const blocked = await coordinator.claim('conv-valid', 'attempt-next', 3_000);
        expect(blocked.acquired).toBe(false);
        expect(blocked.ownerAttemptId).toBe('attempt-valid');

        expect(await store.get(`${prefix}conv-expired`)).toBeNull();
    });
});
