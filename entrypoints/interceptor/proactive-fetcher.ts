export class ProactiveFetcher {
    private readonly inFlight = new Set<string>();

    public markInFlight(key: string): boolean {
        if (this.inFlight.has(key)) {
            return false;
        }
        this.inFlight.add(key);
        return true;
    }

    public clearInFlight(key: string): void {
        this.inFlight.delete(key);
    }
}
