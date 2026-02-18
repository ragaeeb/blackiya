export class ProactiveFetcher {
    private readonly inFlight = new Set<string>();

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
        this.inFlight.add(key);
        return true;
    }

    /**
     * Clears an in-flight key.
     *
     * This should be called in `finally` after a successful `markInFlight(key)`.
     */
    public clearInFlight(key: string): void {
        this.inFlight.delete(key);
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
}
