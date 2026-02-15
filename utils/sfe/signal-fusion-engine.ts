import { AttemptTracker } from '@/utils/sfe/attempt-tracker';
import { InMemoryProbeScheduler, type ProbeScheduler } from '@/utils/sfe/probe-scheduler';
import { ReadinessGate } from '@/utils/sfe/readiness-gate';
import type {
    CanonicalSample,
    CaptureResolution,
    FusionSignal,
    LifecyclePhase,
    AttemptDescriptor,
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

interface SignalFusionEngineOptions {
    tracker?: AttemptTracker;
    probeScheduler?: ProbeScheduler;
    readinessGate?: ReadinessGate;
    now?: () => number;
}

function isRegressive(current: LifecyclePhase, next: LifecyclePhase): boolean {
    if (current === next) {
        return false;
    }
    const allowed = TRANSITIONS[current];
    return !allowed[next];
}

function buildDefaultResolution(descriptor: AttemptDescriptor): CaptureResolution {
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
}

function resolutionFromPhase(
    descriptor: AttemptDescriptor,
    existing: CaptureResolution,
    blocking: CaptureResolution['blockingConditions'],
): CaptureResolution {
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
}

export class SignalFusionEngine {
    private readonly tracker: AttemptTracker;
    private readonly probeScheduler: ProbeScheduler;
    private readonly readinessGate: ReadinessGate;
    private readonly now: () => number;
    private readonly resolutions = new Map<string, CaptureResolution>();

    constructor(options: SignalFusionEngineOptions = {}) {
        this.tracker = options.tracker ?? new AttemptTracker();
        this.probeScheduler = options.probeScheduler ?? new InMemoryProbeScheduler();
        this.readinessGate = options.readinessGate ?? new ReadinessGate();
        this.now = options.now ?? (() => Date.now());
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
        return this.ensureResolution(descriptor, []);
    }

    public resolveByConversation(conversationId: string): CaptureResolution | null {
        const active = this.tracker.getActiveByConversationId(conversationId);
        if (active.length === 0) {
            return null;
        }
        return this.ensureResolution(active[0], []);
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

    private ensureResolution(descriptor: AttemptDescriptor, blocking: CaptureResolution['blockingConditions']): CaptureResolution {
        const existing = this.resolutions.get(descriptor.attemptId) ?? buildDefaultResolution(descriptor);
        const next = resolutionFromPhase(descriptor, existing, blocking);
        this.resolutions.set(descriptor.attemptId, next);
        return next;
    }
}
