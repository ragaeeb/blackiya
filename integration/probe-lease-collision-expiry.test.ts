import { describe, expect, it } from 'bun:test';
import { InMemoryLeaseStore } from '@/tests/helpers/in-memory-lease-store';
import { ProbeLeaseCoordinator } from '@/utils/sfe/probe-lease-coordinator';

describe('integration: probe lease collision + expiry', () => {
    it('enforces single owner until expiry, then transfers ownership deterministically', async () => {
        const storage = new InMemoryLeaseStore();
        let now = 1_000;

        const coordinator = new ProbeLeaseCoordinator({ store: storage, now: () => now });

        const first = await coordinator.claim('conv-lease', 'attempt-a', 5_000);
        expect(first.acquired).toBeTrue();
        expect(first.ownerAttemptId).toBe('attempt-a');

        const blocked = await coordinator.claim('conv-lease', 'attempt-b', 5_000);
        expect(blocked.acquired).toBeFalse();
        expect(blocked.ownerAttemptId).toBe('attempt-a');

        now = 7_000;
        const takeover = await coordinator.claim('conv-lease', 'attempt-b', 3_000);
        expect(takeover.acquired).toBeTrue();
        expect(takeover.ownerAttemptId).toBe('attempt-b');

        const staleRelease = await coordinator.release('conv-lease', 'attempt-a');
        expect(staleRelease).toBeFalse();

        const stillOwned = await coordinator.claim('conv-lease', 'attempt-c', 3_000);
        expect(stillOwned.acquired).toBeFalse();
        expect(stillOwned.ownerAttemptId).toBe('attempt-b');

        const released = await coordinator.release('conv-lease', 'attempt-b');
        expect(released).toBeTrue();

        const freeClaim = await coordinator.claim('conv-lease', 'attempt-c', 2_000);
        expect(freeClaim.acquired).toBeTrue();
        expect(freeClaim.ownerAttemptId).toBe('attempt-c');
    });
});
