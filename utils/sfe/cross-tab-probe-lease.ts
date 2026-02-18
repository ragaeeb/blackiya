interface ProbeLeaseRecord {
    attemptId: string;
    expiresAtMs: number;
    updatedAtMs: number;
}

export interface ProbeLeaseClaimResult {
    acquired: boolean;
    ownerAttemptId: string | null;
    expiresAtMs: number | null;
}

export interface CrossTabProbeLeaseOptions {
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
    now?: () => number;
    keyPrefix?: string;
}

const DEFAULT_KEY_PREFIX = 'blackiya:probe-lease:';

export class CrossTabProbeLease {
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
    private readonly now: () => number;
    private readonly keyPrefix: string;

    public constructor(options?: CrossTabProbeLeaseOptions) {
        this.storage = options?.storage ?? this.resolveStorage();
        this.now = options?.now ?? (() => Date.now());
        this.keyPrefix = options?.keyPrefix ?? DEFAULT_KEY_PREFIX;
    }

    public claim(conversationId: string, attemptId: string, ttlMs: number): ProbeLeaseClaimResult {
        if (!this.storage) {
            return {
                acquired: true,
                ownerAttemptId: attemptId,
                expiresAtMs: this.now() + Math.max(ttlMs, 1),
            };
        }

        const now = this.now();
        const current = this.read(conversationId);
        if (current && current.expiresAtMs > now && current.attemptId !== attemptId) {
            return {
                acquired: false,
                ownerAttemptId: current.attemptId,
                expiresAtMs: current.expiresAtMs,
            };
        }

        const next: ProbeLeaseRecord = {
            attemptId,
            expiresAtMs: now + Math.max(ttlMs, 1),
            updatedAtMs: now,
        };
        if (!this.write(conversationId, next)) {
            return {
                acquired: false,
                ownerAttemptId: null,
                expiresAtMs: null,
            };
        }

        const verify = this.read(conversationId);
        if (!verify || verify.attemptId !== attemptId) {
            return {
                acquired: false,
                ownerAttemptId: verify?.attemptId ?? null,
                expiresAtMs: verify?.expiresAtMs ?? null,
            };
        }

        return {
            acquired: true,
            ownerAttemptId: attemptId,
            expiresAtMs: verify.expiresAtMs,
        };
    }

    public release(conversationId: string, attemptId: string): void {
        if (!this.storage) {
            return;
        }
        const current = this.read(conversationId);
        if (!current) {
            return;
        }
        if (current.attemptId !== attemptId) {
            return;
        }
        try {
            this.storage.removeItem(this.keyFor(conversationId));
        } catch {
            // Ignore storage removal errors; lease will naturally expire.
        }
    }

    public dispose(): void {
        // No background resources retained yet. Reserved for future channel listeners.
    }

    private resolveStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
        try {
            if (typeof window !== 'undefined' && window.localStorage) {
                return window.localStorage;
            }
        } catch {
            return null;
        }
        return null;
    }

    private keyFor(conversationId: string): string {
        return `${this.keyPrefix}${conversationId}`;
    }

    private read(conversationId: string): ProbeLeaseRecord | null {
        if (!this.storage) {
            return null;
        }
        try {
            const raw = this.storage.getItem(this.keyFor(conversationId));
            if (!raw) {
                return null;
            }
            const parsed = JSON.parse(raw) as Partial<ProbeLeaseRecord>;
            if (typeof parsed.attemptId !== 'string') {
                return null;
            }
            if (typeof parsed.expiresAtMs !== 'number') {
                return null;
            }
            return {
                attemptId: parsed.attemptId,
                expiresAtMs: parsed.expiresAtMs,
                updatedAtMs: typeof parsed.updatedAtMs === 'number' ? parsed.updatedAtMs : 0,
            };
        } catch {
            return null;
        }
    }

    private write(conversationId: string, record: ProbeLeaseRecord): boolean {
        if (!this.storage) {
            return false;
        }
        try {
            this.storage.setItem(this.keyFor(conversationId), JSON.stringify(record));
            return true;
        } catch {
            return false;
        }
    }
}
