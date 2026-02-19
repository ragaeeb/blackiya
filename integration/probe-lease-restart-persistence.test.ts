import { describe, expect, it } from 'bun:test';
import { InMemoryLeaseStore } from '@/tests/helpers/in-memory-lease-store';
import { ProbeLeaseCoordinator } from '@/utils/sfe/probe-lease-coordinator';

describe('integration: probe lease restart persistence', () => {
    it('preserves owner lock across coordinator restart and transfers after expiry', async () => {
        const storage = new InMemoryLeaseStore();
        let now = 1_000;

        const coordinatorA = new ProbeLeaseCoordinator({
            store: storage,
            now: () => now,
        });

        const firstClaim = await coordinatorA.claim('conv-restart-1', 'attempt-a', 5_000);
        expect(firstClaim.acquired).toBeTrue();
        expect(firstClaim.ownerAttemptId).toBe('attempt-a');

        now = 1_500;
        const coordinatorB = new ProbeLeaseCoordinator({
            store: storage,
            now: () => now,
        });

        const blockedClaim = await coordinatorB.claim('conv-restart-1', 'attempt-b', 5_000);
        expect(blockedClaim.acquired).toBeFalse();
        expect(blockedClaim.ownerAttemptId).toBe('attempt-a');

        // Stale owner cannot release after takeover window if not current owner.
        const staleReleaseBeforeExpiry = await coordinatorB.release('conv-restart-1', 'attempt-b');
        expect(staleReleaseBeforeExpiry).toBeFalse();

        now = 7_000;
        const takeoverClaim = await coordinatorB.claim('conv-restart-1', 'attempt-b', 4_000);
        expect(takeoverClaim.acquired).toBeTrue();
        expect(takeoverClaim.ownerAttemptId).toBe('attempt-b');

        const staleOwnerRelease = await coordinatorB.release('conv-restart-1', 'attempt-a');
        expect(staleOwnerRelease).toBeFalse();
    });
});
