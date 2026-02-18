export class ProactiveFetcher {
    private readonly maxInFlight: number;
    private readonly now: () => number;
    private readonly inFlight = new Set<string>();
    private readonly inFlightStartedAt = new Map<string, number>();

    public constructor(options?: { maxInFlight?: number; now?: () => number }) {
        this.maxInFlight = Math.max(1, options?.maxInFlight ?? 500);
        this.now = options?.now ?? (() => Date.now());
    }

    /**
     * Marks a key as in-flight.
     *
     * Callers that receive `true` must pair this with `clearInFlight(key)` in a
     * `finally` block to avoid permanently blocking that key.
     */
    public markInFlight(key: string): boolean {
        if (this.inFlight.has(key)) {
            return false;
        }
        this.enforceCapacity();
        this.inFlight.add(key);
        this.inFlightStartedAt.set(key, this.now());
        return true;
    }

    /**
     * Clears an in-flight key.
     *
     * This should be called in `finally` after a successful `markInFlight(key)`.
     */
    public clearInFlight(key: string): void {
        this.inFlight.delete(key);
        this.inFlightStartedAt.delete(key);
    }

    /**
     * Safely executes an async callback while holding the in-flight key.
     * Returns `undefined` when the key is already in-flight.
     */
    public async withInFlight<T>(key: string, callback: () => Promise<T>): Promise<T | undefined> {
        if (!this.markInFlight(key)) {
            return undefined;
        }
        try {
            return await callback();
        } finally {
            this.clearInFlight(key);
        }
    }

    private enforceCapacity(): void {
        while (this.inFlight.size >= this.maxInFlight) {
            const oldest = this.inFlightStartedAt.entries().next().value as [string, number] | undefined;
            if (!oldest) {
                break;
            }
            this.inFlight.delete(oldest[0]);
            this.inFlightStartedAt.delete(oldest[0]);
        }
    }
}
