import type { BlockingCondition, PlatformReadiness } from '@/utils/sfe/types';

type ReadinessGateOptions = {
    minStableMs?: number;
    maxStabilizationWaitMs?: number;
    sampleTtlMs?: number;
    maxSamples?: number;
    pruneMinIntervalMs?: number;
};

type SampleState = {
    firstSeenAtMs: number;
    stabilizationStartedAtMs: number;
    lastSeenAtMs: number;
    contentHash: string;
    terminal: boolean;
    textLength: number;
};

export type ReadinessGateResult = {
    ready: boolean;
    blockingConditions: BlockingCondition[];
};

export class ReadinessGate {
    private samples = new Map<string, SampleState>();
    private readonly minStableMs: number;
    private readonly maxStabilizationWaitMs: number;
    private readonly sampleTtlMs: number;
    private readonly maxSamples: number;
    private readonly pruneMinIntervalMs: number;
    private lastPruneAtMs = 0;

    constructor(options: ReadinessGateOptions = {}) {
        this.minStableMs = options.minStableMs ?? 900;
        this.maxStabilizationWaitMs = options.maxStabilizationWaitMs ?? 30_000;
        this.sampleTtlMs = Math.max(1, options.sampleTtlMs ?? 10 * 60 * 1000);
        this.maxSamples = Math.max(1, options.maxSamples ?? 500);
        this.pruneMinIntervalMs = Math.max(0, options.pruneMinIntervalMs ?? 1000);
    }

    public reset(attemptId: string) {
        this.samples.delete(attemptId);
    }

    public evaluate(attemptId: string, readiness: PlatformReadiness, timestampMs = Date.now()): ReadinessGateResult {
        this.pruneSamples(timestampMs);
        const blocking: BlockingCondition[] = [];

        if (!readiness.contentHash || readiness.latestAssistantTextLength <= 0) {
            blocking.push('no_canonical_data');
            return { ready: false, blockingConditions: blocking };
        }

        if (!readiness.terminal) {
            blocking.push('canonical_not_terminal');
            return { ready: false, blockingConditions: blocking };
        }

        const existing = this.samples.get(attemptId);
        if (!existing) {
            this.samples.set(attemptId, {
                firstSeenAtMs: timestampMs,
                stabilizationStartedAtMs: timestampMs,
                lastSeenAtMs: timestampMs,
                contentHash: readiness.contentHash,
                terminal: readiness.terminal,
                textLength: readiness.latestAssistantTextLength,
            });
            this.pruneSamples(timestampMs);
            blocking.push('awaiting_second_sample');
            return { ready: false, blockingConditions: blocking };
        }

        if (existing.contentHash !== readiness.contentHash) {
            this.samples.set(attemptId, {
                firstSeenAtMs: timestampMs,
                stabilizationStartedAtMs: existing.stabilizationStartedAtMs,
                lastSeenAtMs: timestampMs,
                contentHash: readiness.contentHash,
                terminal: readiness.terminal,
                textLength: readiness.latestAssistantTextLength,
            });
            blocking.push('content_hash_changed');
            if (timestampMs - existing.stabilizationStartedAtMs > this.maxStabilizationWaitMs) {
                blocking.push('stabilization_timeout');
                return { ready: false, blockingConditions: blocking };
            }
            blocking.push('awaiting_second_sample');
            return { ready: false, blockingConditions: blocking };
        }

        existing.lastSeenAtMs = timestampMs;
        existing.terminal = readiness.terminal;
        existing.textLength = readiness.latestAssistantTextLength;

        const stableMs = timestampMs - existing.firstSeenAtMs;
        const totalWaitMs = timestampMs - existing.stabilizationStartedAtMs;
        if (stableMs < this.minStableMs) {
            if (totalWaitMs > this.maxStabilizationWaitMs) {
                blocking.push('stabilization_timeout');
                return { ready: false, blockingConditions: blocking };
            }
            blocking.push('stability_window_not_elapsed');
            return { ready: false, blockingConditions: blocking };
        }

        return {
            ready: true,
            blockingConditions: [],
        };
    }

    private pruneSamples(nowMs: number) {
        if (nowMs - this.lastPruneAtMs < this.pruneMinIntervalMs) {
            return;
        }
        this.lastPruneAtMs = nowMs;

        for (const [attemptId, sample] of this.samples.entries()) {
            if (nowMs - sample.lastSeenAtMs > this.sampleTtlMs) {
                this.samples.delete(attemptId);
            }
        }

        if (this.samples.size <= this.maxSamples) {
            return;
        }

        const overflow = this.samples.size - this.maxSamples;
        const oldest = [...this.samples.entries()]
            .sort((left, right) => left[1].lastSeenAtMs - right[1].lastSeenAtMs)
            .slice(0, overflow);
        for (const [attemptId] of oldest) {
            this.samples.delete(attemptId);
        }
    }
}
