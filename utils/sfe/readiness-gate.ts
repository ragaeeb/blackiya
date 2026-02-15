import type { BlockingCondition, PlatformReadiness } from '@/utils/sfe/types';

interface ReadinessGateOptions {
    minStableMs?: number;
    maxStabilizationWaitMs?: number;
}

interface SampleState {
    firstSeenAtMs: number;
    stabilizationStartedAtMs: number;
    lastSeenAtMs: number;
    contentHash: string;
    terminal: boolean;
    textLength: number;
}

export interface ReadinessGateResult {
    ready: boolean;
    blockingConditions: BlockingCondition[];
}

export class ReadinessGate {
    private samples = new Map<string, SampleState>();
    private readonly minStableMs: number;
    private readonly maxStabilizationWaitMs: number;

    constructor(options: ReadinessGateOptions = {}) {
        this.minStableMs = options.minStableMs ?? 900;
        this.maxStabilizationWaitMs = options.maxStabilizationWaitMs ?? 30_000;
    }

    public reset(attemptId: string): void {
        this.samples.delete(attemptId);
    }

    public evaluate(attemptId: string, readiness: PlatformReadiness, timestampMs = Date.now()): ReadinessGateResult {
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
}
