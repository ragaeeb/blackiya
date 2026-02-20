import { describe, expect, it } from 'bun:test';
import { InMemoryLeaseStore } from '@/tests/helpers/in-memory-lease-store';
import { ProbeLeaseCoordinator, type ProbeLeaseCoordinatorStore } from '@/utils/sfe/probe-lease-coordinator';

class DelayedHydrationStore implements ProbeLeaseCoordinatorStore {
    private readonly entries = new Map<string, string>();
    private readonly delayMs: number;
    private shouldFailGetAll = false;
    public getAllCalls = 0;

    public constructor(delayMs: number) {
        this.delayMs = delayMs;
    }

    public setGetAllFailure(shouldFail: boolean) {
        this.shouldFailGetAll = shouldFail;
    }

    public async seed(key: string, value: string) {
        this.entries.set(key, value);
    }

    public async get(key: string): Promise<string | null> {
        return this.entries.get(key) ?? null;
    }

    public async set(key: string, value: string) {
        this.entries.set(key, value);
    }

    public async remove(key: string) {
        this.entries.delete(key);
    }

    public async getAll(): Promise<Record<string, string>> {
        this.getAllCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        if (this.shouldFailGetAll) {
            throw new Error('getAll failed');
        }
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
        expect(first.acquired).toBeTrue();
        expect(first.ownerAttemptId).toBe('attempt-a');

        const blocked = await coordinator.claim('conv-1', 'attempt-b', 5_000);
        expect(blocked.acquired).toBeFalse();
        expect(blocked.ownerAttemptId).toBe('attempt-a');

        now = 7_000;
        const takeover = await coordinator.claim('conv-1', 'attempt-b', 3_000);
        expect(takeover.acquired).toBeTrue();
        expect(takeover.ownerAttemptId).toBe('attempt-b');
    });

    it('enforces owner-only release and idempotent release', async () => {
        const store = new InMemoryLeaseStore();
        const coordinator = new ProbeLeaseCoordinator({ store, now: () => 10_000 });

        await coordinator.claim('conv-2', 'attempt-a', 5_000);

        expect(await coordinator.release('conv-2', 'attempt-b')).toBeFalse();
        expect(await coordinator.release('conv-2', 'attempt-a')).toBeTrue();
        expect(await coordinator.release('conv-2', 'attempt-a')).toBeFalse();
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
        expect(blocked.acquired).toBeFalse();
        expect(blocked.ownerAttemptId).toBe('attempt-valid');

        expect(await store.get(`${prefix}conv-expired`)).toBeNull();
    });

    it('coalesces concurrent hydration so parallel claims see the same hydrated cache', async () => {
        const now = 50_000;
        const prefix = 'coalesce:';
        const store = new DelayedHydrationStore(10);
        await store.seed(
            `${prefix}conv-race`,
            JSON.stringify({
                attemptId: 'attempt-owner',
                expiresAtMs: now + 10_000,
                updatedAtMs: now - 1_000,
            }),
        );
        const coordinator = new ProbeLeaseCoordinator({
            store,
            now: () => now,
            keyPrefix: prefix,
        });

        const [first, second] = await Promise.all([
            coordinator.claim('conv-race', 'attempt-a', 5_000),
            coordinator.claim('conv-race', 'attempt-b', 5_000),
        ]);

        expect(store.getAllCalls).toBe(1);
        expect(first.acquired).toBeFalse();
        expect(second.acquired).toBeFalse();
        expect(first.ownerAttemptId).toBe('attempt-owner');
        expect(second.ownerAttemptId).toBe('attempt-owner');
    });

    it('retries hydration on later calls if initial getAll fails', async () => {
        const now = 75_000;
        const prefix = 'retry:';
        const store = new DelayedHydrationStore(0);
        await store.seed(
            `${prefix}conv-persisted`,
            JSON.stringify({
                attemptId: 'attempt-persisted',
                expiresAtMs: now + 10_000,
                updatedAtMs: now - 500,
            }),
        );
        store.setGetAllFailure(true);

        const coordinator = new ProbeLeaseCoordinator({
            store,
            now: () => now,
            keyPrefix: prefix,
        });

        const first = await coordinator.claim('conv-first', 'attempt-new', 5_000);
        expect(first.acquired).toBeTrue();
        expect(store.getAllCalls).toBe(1);

        store.setGetAllFailure(false);
        const second = await coordinator.claim('conv-persisted', 'attempt-contender', 5_000);

        expect(store.getAllCalls).toBe(2);
        expect(second.acquired).toBeFalse();
        expect(second.ownerAttemptId).toBe('attempt-persisted');
    });

    it('respects persisted lease after coordinator re-instantiation', async () => {
        const store = new InMemoryLeaseStore();
        const now = 90_000;
        const firstCoordinator = new ProbeLeaseCoordinator({
            store,
            now: () => now,
        });
        const firstClaim = await firstCoordinator.claim('conv-restart', 'attempt-owner', 10_000);
        expect(firstClaim.acquired).toBeTrue();

        const secondCoordinator = new ProbeLeaseCoordinator({
            store,
            now: () => now,
        });
        const secondClaim = await secondCoordinator.claim('conv-restart', 'attempt-contender', 10_000);
        expect(secondClaim.acquired).toBeFalse();
        expect(secondClaim.ownerAttemptId).toBe('attempt-owner');
    });

    it('returns null-owner error response when store write fails', async () => {
        const failingStore: ProbeLeaseCoordinatorStore = {
            get: async () => null,
            set: async () => {
                throw new Error('quota exceeded');
            },
            remove: async () => {},
        };
        const coordinator = new ProbeLeaseCoordinator({ store: failingStore, now: () => 1_000 });
        const result = await coordinator.claim('conv-x', 'attempt-x', 5_000);
        expect(result.acquired).toBe(false);
        expect(result.ownerAttemptId).toBeNull();
    });

    it('evicts the oldest entry when maxEntries is exceeded', async () => {
        const store = new InMemoryLeaseStore();
        const coordinator = new ProbeLeaseCoordinator({ store, now: () => 1_000, maxEntries: 1 });
        await coordinator.claim('conv-a', 'attempt-a', 5_000);
        await coordinator.claim('conv-b', 'attempt-b', 5_000);
        // conv-a was evicted; conv-b should block a new attempt
        const result = await coordinator.claim('conv-b', 'attempt-c', 3_000);
        expect(result.acquired).toBe(false);
    });

    it('evicts by lease age (expiresAt/updatedAt), not newest insertion order', async () => {
        const store = new InMemoryLeaseStore();
        let now = 0;
        const coordinator = new ProbeLeaseCoordinator({
            store,
            now: () => now,
            maxEntries: 2,
        });

        await coordinator.claim('conv-a', 'attempt-a', 1_000); // expires 1000
        now = 1;
        await coordinator.claim('conv-b', 'attempt-b', 1_000); // expires 1001
        now = 2;
        await coordinator.claim('conv-c', 'attempt-c', 10); // expires 12 (oldest lease age despite newest insertion)

        now = 3;
        const convAStillOwned = await coordinator.claim('conv-a', 'attempt-z', 1_000);
        expect(convAStillOwned.acquired).toBeFalse();
        expect(convAStillOwned.ownerAttemptId).toBe('attempt-a');

        const convCEvicted = await coordinator.claim('conv-c', 'attempt-z', 1_000);
        expect(convCEvicted.acquired).toBeTrue();
    });
});
