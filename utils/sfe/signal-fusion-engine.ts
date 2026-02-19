import { AttemptTracker } from '@/utils/sfe/attempt-tracker';
import { InMemoryProbeScheduler, type ProbeScheduler } from '@/utils/sfe/probe-scheduler';
import { ReadinessGate } from '@/utils/sfe/readiness-gate';
import type {
    AttemptDescriptor,
    CanonicalSample,
    CaptureResolution,
    FusionSignal,
    LifecyclePhase,
} from '@/utils/sfe/types';

const TRANSITIONS: Record<LifecyclePhase, Partial<Record<LifecyclePhase, LifecyclePhase>>> = {
    idle: {
        prompt_sent: 'prompt_sent',
        streaming: 'streaming',
        completed_hint: 'completed_hint',
        canonical_probing: 'canonical_probing',
    },
    prompt_sent: {
        streaming: 'streaming',
        completed_hint: 'completed_hint',
        canonical_probing: 'canonical_probing',
        superseded: 'superseded',
        disposed: 'disposed',
    },
    streaming: {
        completed_hint: 'completed_hint',
        canonical_probing: 'canonical_probing',
        terminated_partial: 'terminated_partial',
        error: 'error',
        superseded: 'superseded',
        disposed: 'disposed',
    },
    completed_hint: {
        canonical_probing: 'canonical_probing',
        terminated_partial: 'terminated_partial',
        superseded: 'superseded',
        disposed: 'disposed',
    },
    canonical_probing: {
        captured_ready: 'captured_ready',
        terminated_partial: 'terminated_partial',
        error: 'error',
        superseded: 'superseded',
        disposed: 'disposed',
    },
    captured_ready: {
        superseded: 'superseded',
        disposed: 'disposed',
    },
    terminated_partial: {
        disposed: 'disposed',
    },
    error: {
        disposed: 'disposed',
    },
    superseded: {
        disposed: 'disposed',
    },
    disposed: {},
};

type SignalFusionEngineOptions = {
    tracker?: AttemptTracker;
    probeScheduler?: ProbeScheduler;
    readinessGate?: ReadinessGate;
    now?: () => number;
    maxResolutions?: number;
    terminalResolutionTtlMs?: number;
    pruneMinIntervalMs?: number;
};

const isRegressive = (current: LifecyclePhase, next: LifecyclePhase): boolean => {
    if (current === next) {
        return false;
    }
    const allowed = TRANSITIONS[current];
    return !allowed[next];
};

const buildDefaultResolution = (descriptor: AttemptDescriptor): CaptureResolution => {
    return {
        attemptId: descriptor.attemptId,
        platform: descriptor.platform,
        conversationId: descriptor.conversationId ?? null,
        platformGenerationId: descriptor.platformGenerationId ?? null,
        phase: descriptor.phase,
        ready: false,
        reason: 'not_captured',
        blockingConditions: ['no_canonical_data'],
        updatedAtMs: descriptor.updatedAtMs,
    };
};

const resolutionFromPhase = (
    descriptor: AttemptDescriptor,
    existing: CaptureResolution,
    blocking: CaptureResolution['blockingConditions'],
): CaptureResolution => {
    const phase = descriptor.phase;

    if (phase === 'captured_ready') {
        return {
            ...existing,
            attemptId: descriptor.attemptId,
            platform: descriptor.platform,
            conversationId: descriptor.conversationId ?? null,
            platformGenerationId: descriptor.platformGenerationId ?? null,
            phase,
            ready: true,
            reason: 'ready',
            blockingConditions: [],
            updatedAtMs: descriptor.updatedAtMs,
        };
    }

    if (phase === 'terminated_partial') {
        return {
            ...existing,
            phase,
            ready: false,
            reason: 'terminated_partial',
            blockingConditions: blocking.length > 0 ? blocking : ['canonical_not_terminal'],
            updatedAtMs: descriptor.updatedAtMs,
        };
    }

    if (phase === 'error') {
        return {
            ...existing,
            phase,
            ready: false,
            reason: 'error',
            blockingConditions: blocking.length > 0 ? blocking : ['no_canonical_data'],
            updatedAtMs: descriptor.updatedAtMs,
        };
    }

    const reason = blocking.length > 0 ? 'awaiting_stabilization' : 'captured_not_ready';
    return {
        ...existing,
        attemptId: descriptor.attemptId,
        platform: descriptor.platform,
        conversationId: descriptor.conversationId ?? null,
        platformGenerationId: descriptor.platformGenerationId ?? null,
        phase,
        ready: false,
        reason,
        blockingConditions: blocking,
        updatedAtMs: descriptor.updatedAtMs,
    };
};

export class SignalFusionEngine {
    private readonly tracker: AttemptTracker;
    private readonly probeScheduler: ProbeScheduler;
    private readonly readinessGate: ReadinessGate;
    private readonly now: () => number;
    private readonly maxResolutions: number;
    private readonly terminalResolutionTtlMs: number;
    private readonly pruneMinIntervalMs: number;
    private readonly resolutions = new Map<string, CaptureResolution>();
    private lastPruneAtMs = 0;

    constructor(options: SignalFusionEngineOptions = {}) {
        this.tracker = options.tracker ?? new AttemptTracker();
        this.probeScheduler = options.probeScheduler ?? new InMemoryProbeScheduler();
        this.readinessGate = options.readinessGate ?? new ReadinessGate();
        this.now = options.now ?? (() => Date.now());
        this.maxResolutions = Math.max(1, options.maxResolutions ?? 800);
        this.terminalResolutionTtlMs = Math.max(1_000, options.terminalResolutionTtlMs ?? 10 * 60 * 1000);
        this.pruneMinIntervalMs = Math.max(0, options.pruneMinIntervalMs ?? 1000);
    }

    public ingestSignal(signal: FusionSignal): CaptureResolution {
        const descriptor = this.tracker.create({
            attemptId: signal.attemptId,
            platform: signal.platform,
            conversationId: signal.conversationId ?? null,
            platformGenerationId: signal.platformGenerationId ?? null,
            phase: 'idle',
            timestampMs: signal.timestampMs,
        });

        if (signal.conversationId) {
            this.tracker.updateConversationId(signal.attemptId, signal.conversationId, signal.timestampMs);
        }

        const currentPhase = descriptor.phase;
        if (descriptor.disposed || currentPhase === 'disposed') {
            return this.ensureResolution(this.tracker.get(signal.attemptId) ?? descriptor, ['disposed']);
        }

        if (isRegressive(currentPhase, signal.phase)) {
            return this.ensureResolution(this.tracker.get(signal.attemptId) ?? descriptor, []);
        }

        const updated = this.tracker.updatePhase(signal.attemptId, signal.phase, signal.timestampMs) ?? descriptor;
        if (updated.phase === 'completed_hint') {
            this.probeScheduler.start(updated.attemptId);
        }

        if (updated.phase === 'superseded' || updated.phase === 'disposed' || updated.phase === 'captured_ready') {
            this.probeScheduler.cancel(updated.attemptId);
        }

        return this.ensureResolution(updated, []);
    }

    public applyCanonicalSample(sample: CanonicalSample): CaptureResolution {
        const descriptor = this.tracker.create({
            attemptId: sample.attemptId,
            platform: sample.platform,
            conversationId: sample.conversationId ?? sample.data.conversation_id,
            phase: 'canonical_probing',
            timestampMs: sample.timestampMs,
        });

        const current = this.tracker.get(sample.attemptId) ?? descriptor;
        if (current.disposed || current.phase === 'superseded' || current.phase === 'disposed') {
            return this.ensureResolution(current, ['disposed']);
        }

        if (current.phase !== 'canonical_probing' && current.phase !== 'captured_ready') {
            this.tracker.updatePhase(sample.attemptId, 'canonical_probing', sample.timestampMs);
        }

        const result = this.readinessGate.evaluate(sample.attemptId, sample.readiness, sample.timestampMs);
        if (result.ready) {
            this.tracker.updatePhase(sample.attemptId, 'captured_ready', sample.timestampMs);
            const readyDescriptor = this.tracker.get(sample.attemptId) ?? current;
            return this.ensureResolution(readyDescriptor, []);
        }

        const probingDescriptor = this.tracker.get(sample.attemptId) ?? current;
        return this.ensureResolution(probingDescriptor, result.blockingConditions);
    }

    public resolve(attemptId: string): CaptureResolution {
        const descriptor = this.tracker.get(attemptId);
        if (!descriptor) {
            return {
                attemptId,
                platform: 'Unknown',
                phase: 'idle',
                ready: false,
                reason: 'not_captured',
                blockingConditions: ['no_canonical_data'],
                updatedAtMs: this.now(),
            };
        }

        const existingResolution = this.resolutions.get(attemptId);
        if (
            existingResolution &&
            existingResolution.phase === descriptor.phase &&
            existingResolution.updatedAtMs >= descriptor.updatedAtMs
        ) {
            return existingResolution;
        }
        return this.ensureResolution(descriptor, existingResolution?.blockingConditions ?? []);
    }

    public resolveByConversation(conversationId: string): CaptureResolution | null {
        const active = this.tracker.getActiveByConversationId(conversationId);
        if (active.length === 0) {
            return null;
        }
        const descriptor = active[0];
        const attemptId = descriptor.attemptId;
        const existingResolution = this.resolutions.get(attemptId);
        if (
            existingResolution &&
            existingResolution.phase === descriptor.phase &&
            existingResolution.updatedAtMs >= descriptor.updatedAtMs
        ) {
            return existingResolution;
        }
        return this.ensureResolution(descriptor, existingResolution?.blockingConditions ?? []);
    }

    public restartCanonicalRecovery(attemptId: string, timestampMs = this.now()): CaptureResolution | null {
        const descriptor = this.tracker.get(attemptId);
        if (
            !descriptor ||
            descriptor.disposed ||
            descriptor.phase === 'superseded' ||
            descriptor.phase === 'disposed'
        ) {
            return null;
        }
        if (descriptor.phase === 'captured_ready') {
            return this.ensureResolution(descriptor, []);
        }

        this.readinessGate.reset(attemptId);
        this.tracker.updatePhase(attemptId, 'canonical_probing', timestampMs);
        const updated = this.tracker.get(attemptId) ?? descriptor;
        return this.ensureResolution(updated, ['awaiting_second_sample']);
    }

    public dispose(attemptId: string): CaptureResolution {
        this.probeScheduler.cancel(attemptId);
        this.readinessGate.reset(attemptId);
        const descriptor = this.tracker.dispose(attemptId, this.now());
        if (!descriptor) {
            return {
                attemptId,
                platform: 'Unknown',
                phase: 'disposed',
                ready: false,
                reason: 'not_captured',
                blockingConditions: ['disposed'],
                updatedAtMs: this.now(),
            };
        }
        return this.ensureResolution(descriptor, ['disposed']);
    }

    public disposeAll(predicate?: (attempt: AttemptDescriptor) => boolean): string[] {
        const disposedIds: string[] = [];
        for (const attempt of this.tracker.all()) {
            if (predicate && !predicate(attempt)) {
                continue;
            }
            this.dispose(attempt.attemptId);
            disposedIds.push(attempt.attemptId);
        }
        return disposedIds;
    }

    public getAttemptTracker(): AttemptTracker {
        return this.tracker;
    }

    private ensureResolution(
        descriptor: AttemptDescriptor,
        blocking: CaptureResolution['blockingConditions'],
    ): CaptureResolution {
        this.pruneResolutionCache();
        const existing = this.resolutions.get(descriptor.attemptId) ?? buildDefaultResolution(descriptor);
        const next = resolutionFromPhase(descriptor, existing, blocking);
        this.resolutions.set(descriptor.attemptId, next);
        return next;
    }

    private pruneResolutionCache() {
        const now = this.now();
        if (now - this.lastPruneAtMs < this.pruneMinIntervalMs) {
            return;
        }
        this.lastPruneAtMs = now;
        if (this.resolutions.size === 0) {
            return;
        }
        const activeAttemptIds = new Set(this.tracker.all().map((attempt) => attempt.attemptId));
        for (const [attemptId, resolution] of this.resolutions.entries()) {
            if (!activeAttemptIds.has(attemptId)) {
                this.resolutions.delete(attemptId);
                continue;
            }
            if (
                (resolution.phase === 'disposed' ||
                    resolution.phase === 'superseded' ||
                    resolution.phase === 'captured_ready' ||
                    resolution.phase === 'terminated_partial' ||
                    resolution.phase === 'error') &&
                now - resolution.updatedAtMs > this.terminalResolutionTtlMs
            ) {
                this.resolutions.delete(attemptId);
            }
        }

        if (this.resolutions.size <= this.maxResolutions) {
            return;
        }

        const ordered = [...this.resolutions.values()].sort((left, right) => left.updatedAtMs - right.updatedAtMs);
        for (const resolution of ordered) {
            if (this.resolutions.size <= this.maxResolutions) {
                return;
            }
            this.resolutions.delete(resolution.attemptId);
        }
    }
}
