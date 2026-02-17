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

describe('integration: probe lease collision + expiry', () => {
    it('enforces single owner until expiry, then transfers ownership deterministically', () => {
        const storage = new InMemoryStorage();
        let now = 1_000;

        const tabA = new CrossTabProbeLease({ storage, now: () => now });
        const tabB = new CrossTabProbeLease({ storage, now: () => now });

        const first = tabA.claim('conv-lease', 'attempt-a', 5_000);
        expect(first.acquired).toBe(true);
        expect(first.ownerAttemptId).toBe('attempt-a');

        const blocked = tabB.claim('conv-lease', 'attempt-b', 5_000);
        expect(blocked.acquired).toBe(false);
        expect(blocked.ownerAttemptId).toBe('attempt-a');

        now = 7_000;
        const takeover = tabB.claim('conv-lease', 'attempt-b', 3_000);
        expect(takeover.acquired).toBe(true);
        expect(takeover.ownerAttemptId).toBe('attempt-b');

        const staleRelease = tabA.release('conv-lease', 'attempt-a');
        expect(staleRelease).toBeUndefined();

        const stillOwned = tabA.claim('conv-lease', 'attempt-c', 3_000);
        expect(stillOwned.acquired).toBe(false);
        expect(stillOwned.ownerAttemptId).toBe('attempt-b');

        tabB.release('conv-lease', 'attempt-b');

        const freeClaim = tabA.claim('conv-lease', 'attempt-c', 2_000);
        expect(freeClaim.acquired).toBe(true);
        expect(freeClaim.ownerAttemptId).toBe('attempt-c');
    });
});
