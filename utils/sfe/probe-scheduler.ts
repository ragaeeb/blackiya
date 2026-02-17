interface ProbeTask {
    controller: AbortController;
    startedAtMs: number;
}

export interface ProbeScheduler {
    start(attemptId: string): AbortSignal;
    cancel(attemptId: string): void;
    isRunning(attemptId: string): boolean;
    cancelAll(): void;
}

export class InMemoryProbeScheduler implements ProbeScheduler {
    private tasks = new Map<string, ProbeTask>();

    public start(attemptId: string): AbortSignal {
        this.cancel(attemptId);
        const controller = new AbortController();
        this.tasks.set(attemptId, {
            controller,
            startedAtMs: Date.now(),
        });
        return controller.signal;
    }

    public cancel(attemptId: string): void {
        const task = this.tasks.get(attemptId);
        if (!task) {
            return;
        }
        task.controller.abort();
        this.tasks.delete(attemptId);
    }

    public isRunning(attemptId: string): boolean {
        return this.tasks.has(attemptId);
    }

    public cancelAll(): void {
        for (const task of this.tasks.values()) {
            task.controller.abort();
        }
        this.tasks.clear();
    }
}
