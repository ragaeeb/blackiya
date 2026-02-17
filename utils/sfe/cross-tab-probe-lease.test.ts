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
});
