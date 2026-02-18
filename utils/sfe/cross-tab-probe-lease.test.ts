import { describe, expect, it } from 'bun:test';
import { CrossTabProbeLease } from '@/utils/sfe/cross-tab-probe-lease';

class InMemoryStorage implements Storage {
    private readonly map = new Map<string, string>();

    public get length(): number {
        return this.map.size;
    }

    public clear(): void {
        this.map.clear();
    }

    public getItem(key: string): string | null {
        return this.map.has(key) ? (this.map.get(key) ?? null) : null;
    }

    public key(index: number): string | null {
        return Array.from(this.map.keys())[index] ?? null;
    }

    public removeItem(key: string): void {
        this.map.delete(key);
    }

    public setItem(key: string, value: string): void {
        this.map.set(key, value);
    }
}

class RaceOnWriteStorage extends InMemoryStorage {
    public override setItem(key: string, value: string): void {
        const parsed = JSON.parse(value) as { expiresAtMs: number };
        super.setItem(
            key,
            JSON.stringify({
                attemptId: 'racing-attempt',
                expiresAtMs: parsed.expiresAtMs,
                updatedAtMs: parsed.expiresAtMs - 1,
            }),
        );
    }
}

class ThrowingWriteStorage extends InMemoryStorage {
    public override setItem(_key: string, _value: string): void {
        throw new Error('quota-exceeded');
    }
}

describe('CrossTabProbeLease', () => {
    it('allows a first claimant and blocks competing non-expired claim', () => {
        const storage = new InMemoryStorage();
        const now = 1_000;

        const leaseA = new CrossTabProbeLease({
            storage,
            now: () => now,
        });

        const leaseB = new CrossTabProbeLease({
            storage,
            now: () => now,
        });

        const claimA = leaseA.claim('conv-1', 'attempt-a', 5_000);
        expect(claimA.acquired).toBe(true);

        const claimB = leaseB.claim('conv-1', 'attempt-b', 5_000);
        expect(claimB.acquired).toBe(false);
        expect(claimB.ownerAttemptId).toBe('attempt-a');
        expect(claimB.expiresAtMs).toBe(6_000);
    });

    it('allows claim takeover after lease expiry', () => {
        const storage = new InMemoryStorage();
        let now = 10_000;

        const leaseA = new CrossTabProbeLease({
            storage,
            now: () => now,
        });
        const leaseB = new CrossTabProbeLease({
            storage,
            now: () => now,
        });

        expect(leaseA.claim('conv-2', 'attempt-a', 1_000).acquired).toBe(true);
        now = 11_500;

        const claimB = leaseB.claim('conv-2', 'attempt-b', 2_000);
        expect(claimB.acquired).toBe(true);
        expect(claimB.expiresAtMs).toBe(13_500);
    });

    it('only releases when owner attempt matches', () => {
        const storage = new InMemoryStorage();
        let now = 50_000;

        const lease = new CrossTabProbeLease({
            storage,
            now: () => now,
        });

        expect(lease.claim('conv-3', 'attempt-a', 4_000).acquired).toBe(true);

        lease.release('conv-3', 'attempt-b');
        const blocked = lease.claim('conv-3', 'attempt-c', 4_000);
        expect(blocked.acquired).toBe(false);
        expect(blocked.ownerAttemptId).toBe('attempt-a');

        lease.release('conv-3', 'attempt-a');
        const afterRelease = lease.claim('conv-3', 'attempt-c', 4_000);
        expect(afterRelease.acquired).toBe(true);

        now = 55_000;
        lease.dispose();
    });

    it('returns not acquired when post-write verification sees a different owner', () => {
        const storage = new RaceOnWriteStorage();
        const lease = new CrossTabProbeLease({
            storage,
            now: () => 1_000,
        });

        const claim = lease.claim('conv-race', 'attempt-a', 5_000);
        expect(claim.acquired).toBe(false);
        expect(claim.ownerAttemptId).toBe('racing-attempt');
    });

    it('does not throw when storage write fails and reports lease as not acquired', () => {
        const storage = new ThrowingWriteStorage();
        storage.setItem = () => {
            throw new Error('quota-exceeded');
        };
        const lease = new CrossTabProbeLease({
            storage,
            now: () => 2_000,
        });

        expect(() => lease.claim('conv-fail', 'attempt-a', 5_000)).not.toThrow();
        const claim = lease.claim('conv-fail', 'attempt-a', 5_000);
        expect(claim.acquired).toBe(false);
        expect(claim.ownerAttemptId).toBeNull();
        expect(claim.expiresAtMs).toBeNull();
    });
});
