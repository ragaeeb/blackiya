import type { ProbeLeaseClaimResponse } from '@/utils/sfe/probe-lease-protocol';

type ProbeLeaseRecord = {
    attemptId: string;
    expiresAtMs: number;
    updatedAtMs: number;
};

export interface ProbeLeaseCoordinatorStore {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
    getAll?: () => Promise<Record<string, string>>;
}

export interface ProbeLeaseCoordinatorOptions {
    store: ProbeLeaseCoordinatorStore;
    now?: () => number;
    keyPrefix?: string;
    maxEntries?: number;
}

const DEFAULT_KEY_PREFIX = 'blackiya:probe-lease:';
const DEFAULT_MAX_ENTRIES = 2_000;

export class ProbeLeaseCoordinator {
    private readonly store: ProbeLeaseCoordinatorStore;
    private readonly now: () => number;
    private readonly keyPrefix: string;
    private readonly maxEntries: number;
    private readonly cache = new Map<string, ProbeLeaseRecord>();
    private hydrated = false;

    public constructor(options: ProbeLeaseCoordinatorOptions) {
        this.store = options.store;
        this.now = options.now ?? (() => Date.now());
        this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
        this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    }

    public async claim(conversationId: string, attemptId: string, ttlMs: number): Promise<ProbeLeaseClaimResponse> {
        await this.ensureHydrated();
        const now = this.now();
        await this.pruneExpired(now);

        const existing = this.cache.get(conversationId);
        if (existing && existing.expiresAtMs > now && existing.attemptId !== attemptId) {
            return {
                type: 'BLACKIYA_PROBE_LEASE_CLAIM_RESULT',
                acquired: false,
                ownerAttemptId: existing.attemptId,
                expiresAtMs: existing.expiresAtMs,
            };
        }

        const next: ProbeLeaseRecord = {
            attemptId,
            expiresAtMs: now + Math.max(ttlMs, 1),
            updatedAtMs: now,
        };
        this.cache.set(conversationId, next);
        this.trimToMaxEntries();

        try {
            await this.store.set(this.keyFor(conversationId), JSON.stringify(next));
        } catch {
            this.cache.delete(conversationId);
            return {
                type: 'BLACKIYA_PROBE_LEASE_CLAIM_RESULT',
                acquired: false,
                ownerAttemptId: null,
                expiresAtMs: null,
            };
        }

        return {
            type: 'BLACKIYA_PROBE_LEASE_CLAIM_RESULT',
            acquired: true,
            ownerAttemptId: attemptId,
            expiresAtMs: next.expiresAtMs,
        };
    }

    public async release(conversationId: string, attemptId: string): Promise<boolean> {
        await this.ensureHydrated();
        const now = this.now();
        await this.pruneExpired(now);

        const existing = this.cache.get(conversationId);
        if (!existing || existing.attemptId !== attemptId) {
            return false;
        }

        this.cache.delete(conversationId);
        try {
            await this.store.remove(this.keyFor(conversationId));
        } catch {
            // Keep release best-effort and idempotent.
        }
        return true;
    }

    private async ensureHydrated(): Promise<void> {
        if (this.hydrated) {
            return;
        }
        this.hydrated = true;
        if (!this.store.getAll) {
            return;
        }

        let rawEntries: Record<string, string>;
        try {
            rawEntries = await this.store.getAll();
        } catch {
            return;
        }

        for (const [storageKey, rawValue] of Object.entries(rawEntries)) {
            if (!storageKey.startsWith(this.keyPrefix) || typeof rawValue !== 'string') {
                continue;
            }
            const conversationId = storageKey.slice(this.keyPrefix.length);
            const parsed = this.parseRecord(rawValue);
            if (!conversationId || !parsed) {
                continue;
            }
            this.cache.set(conversationId, parsed);
        }
        this.trimToMaxEntries();
    }

    private async pruneExpired(now: number): Promise<void> {
        const expired: string[] = [];
        for (const [conversationId, record] of this.cache.entries()) {
            if (record.expiresAtMs <= now) {
                expired.push(conversationId);
            }
        }
        for (const conversationId of expired) {
            this.cache.delete(conversationId);
            try {
                await this.store.remove(this.keyFor(conversationId));
            } catch {
                // Ignore storage cleanup errors; expired lease is already dropped from memory.
            }
        }
    }

    private trimToMaxEntries(): void {
        while (this.cache.size > this.maxEntries) {
            const oldestEntry = this.cache.entries().next().value as [string, ProbeLeaseRecord] | undefined;
            if (!oldestEntry) {
                break;
            }
            this.cache.delete(oldestEntry[0]);
            void this.store.remove(this.keyFor(oldestEntry[0])).catch(() => {
                // Best-effort eviction cleanup.
            });
        }
    }

    private parseRecord(raw: string): ProbeLeaseRecord | null {
        try {
            const parsed = JSON.parse(raw) as Partial<ProbeLeaseRecord>;
            if (typeof parsed.attemptId !== 'string') {
                return null;
            }
            if (typeof parsed.expiresAtMs !== 'number') {
                return null;
            }
            const updatedAtMs = typeof parsed.updatedAtMs === 'number' ? parsed.updatedAtMs : 0;
            return {
                attemptId: parsed.attemptId,
                expiresAtMs: parsed.expiresAtMs,
                updatedAtMs,
            };
        } catch {
            return null;
        }
    }

    private keyFor(conversationId: string): string {
        return `${this.keyPrefix}${conversationId}`;
    }
}
