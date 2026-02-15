import { createAttemptId } from '@/utils/protocol/messages';
import type { AttemptDescriptor, LifecyclePhase } from '@/utils/sfe/types';

interface CreateAttemptInput {
    attemptId?: string;
    platform: string;
    conversationId?: string | null;
    platformGenerationId?: string | null;
    phase?: LifecyclePhase;
    timestampMs?: number;
}

export class AttemptTracker {
    private attempts = new Map<string, AttemptDescriptor>();
    private activeByConversation = new Map<string, string>();

    constructor(private readonly maxEntries = 500) {}

    public create(input: CreateAttemptInput): AttemptDescriptor {
        const now = input.timestampMs ?? Date.now();
        const attemptId = input.attemptId ?? createAttemptId(input.platform.toLowerCase());
        const existing = this.attempts.get(attemptId);
        if (existing) {
            return existing;
        }

        const descriptor: AttemptDescriptor = {
            attemptId,
            platform: input.platform,
            createdAtMs: now,
            updatedAtMs: now,
            conversationId: input.conversationId ?? null,
            platformGenerationId: input.platformGenerationId ?? null,
            phase: input.phase ?? 'idle',
            disposed: false,
        };

        this.attempts.set(attemptId, descriptor);
        if (descriptor.conversationId) {
            const prior = this.activeByConversation.get(descriptor.conversationId);
            if (prior && prior !== descriptor.attemptId) {
                this.markSuperseded(prior, descriptor.attemptId, now);
            }
            this.activeByConversation.set(descriptor.conversationId, descriptor.attemptId);
        }

        this.trim();
        return descriptor;
    }

    public get(attemptId: string): AttemptDescriptor | undefined {
        return this.attempts.get(attemptId);
    }

    public getActiveByConversationId(conversationId: string): AttemptDescriptor[] {
        const activeAttemptId = this.activeByConversation.get(conversationId);
        if (!activeAttemptId) {
            return [];
        }
        const attempt = this.attempts.get(activeAttemptId);
        if (!attempt || attempt.disposed) {
            return [];
        }
        return [attempt];
    }

    public updateConversationId(
        attemptId: string,
        conversationId: string,
        timestampMs = Date.now(),
    ): AttemptDescriptor | null {
        const descriptor = this.attempts.get(attemptId);
        if (!descriptor || descriptor.disposed) {
            return null;
        }

        descriptor.conversationId = conversationId;
        descriptor.updatedAtMs = timestampMs;

        const prior = this.activeByConversation.get(conversationId);
        if (prior && prior !== descriptor.attemptId) {
            this.markSuperseded(prior, descriptor.attemptId, timestampMs);
        }
        this.activeByConversation.set(conversationId, descriptor.attemptId);
        return descriptor;
    }

    public updatePhase(attemptId: string, phase: LifecyclePhase, timestampMs = Date.now()): AttemptDescriptor | null {
        const descriptor = this.attempts.get(attemptId);
        if (!descriptor || descriptor.disposed) {
            return null;
        }
        descriptor.phase = phase;
        descriptor.updatedAtMs = timestampMs;
        return descriptor;
    }

    public markSuperseded(
        attemptId: string,
        supersededByAttemptId: string,
        timestampMs = Date.now(),
    ): AttemptDescriptor | null {
        const descriptor = this.attempts.get(attemptId);
        if (!descriptor || descriptor.disposed) {
            return null;
        }
        descriptor.phase = 'superseded';
        descriptor.supersededByAttemptId = supersededByAttemptId;
        descriptor.updatedAtMs = timestampMs;

        if (descriptor.conversationId) {
            const activeId = this.activeByConversation.get(descriptor.conversationId);
            if (activeId === descriptor.attemptId) {
                this.activeByConversation.delete(descriptor.conversationId);
            }
        }
        return descriptor;
    }

    public dispose(attemptId: string, timestampMs = Date.now()): AttemptDescriptor | null {
        const descriptor = this.attempts.get(attemptId);
        if (!descriptor) {
            return null;
        }
        descriptor.disposed = true;
        descriptor.phase = 'disposed';
        descriptor.updatedAtMs = timestampMs;
        if (descriptor.conversationId) {
            const activeId = this.activeByConversation.get(descriptor.conversationId);
            if (activeId === descriptor.attemptId) {
                this.activeByConversation.delete(descriptor.conversationId);
            }
        }
        return descriptor;
    }

    public disposeAllForRouteChange(timestampMs = Date.now()): string[] {
        const disposed: string[] = [];
        for (const descriptor of this.attempts.values()) {
            if (descriptor.disposed) {
                continue;
            }
            if (
                descriptor.phase === 'captured_ready' ||
                descriptor.phase === 'error' ||
                descriptor.phase === 'terminated_partial' ||
                descriptor.phase === 'superseded'
            ) {
                continue;
            }
            this.dispose(descriptor.attemptId, timestampMs);
            disposed.push(descriptor.attemptId);
        }
        return disposed;
    }

    public size(): number {
        return this.attempts.size;
    }

    public all(): AttemptDescriptor[] {
        return [...this.attempts.values()];
    }

    private trim(): void {
        if (this.attempts.size <= this.maxEntries) {
            return;
        }

        const evictable = [...this.attempts.values()]
            .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
            .filter(
                (attempt) =>
                    attempt.disposed ||
                    attempt.phase === 'superseded' ||
                    attempt.phase === 'error' ||
                    attempt.phase === 'terminated_partial',
            );

        for (const attempt of evictable) {
            if (this.attempts.size <= this.maxEntries) {
                return;
            }
            this.attempts.delete(attempt.attemptId);
            if (attempt.conversationId && this.activeByConversation.get(attempt.conversationId) === attempt.attemptId) {
                this.activeByConversation.delete(attempt.conversationId);
            }
        }
    }
}
