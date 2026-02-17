import { type LogLevel, logger } from '@/utils/logger';

interface AttemptBudgetState {
    debug: number;
    info: number;
    budgetWarningEmitted: boolean;
}

interface DedupeItem {
    lastAt: number;
}

interface StructuredLoggerOptions {
    debugBudget?: number;
    infoBudget?: number;
    dedupeTtlMs?: number;
}

export class StructuredAttemptLogger {
    private readonly debugBudget: number;
    private readonly infoBudget: number;
    private readonly dedupeTtlMs: number;
    private readonly budgets = new Map<string, AttemptBudgetState>();
    private readonly dedupeCache = new Map<string, DedupeItem>();

    constructor(options: StructuredLoggerOptions = {}) {
        this.debugBudget = options.debugBudget ?? 50;
        this.infoBudget = options.infoBudget ?? 20;
        this.dedupeTtlMs = options.dedupeTtlMs ?? 1500;
    }

    public emit(
        attemptId: string,
        level: LogLevel,
        eventCode: string,
        message: string,
        data?: unknown,
        dedupeKey?: string,
    ): void {
        if (!this.withinBudget(attemptId, level)) {
            return;
        }

        const dedupeLookup = `${attemptId}:${eventCode}:${dedupeKey ?? ''}`;
        if (!this.shouldEmit(dedupeLookup)) {
            return;
        }

        const payload = {
            attemptId,
            eventCode,
            ...(data !== undefined ? { data } : {}),
        };

        if (level === 'error') {
            logger.error(message, payload);
            return;
        }
        if (level === 'warn') {
            logger.warn(message, payload);
            return;
        }
        if (level === 'debug') {
            logger.debug(message, payload);
            return;
        }
        logger.info(message, payload);
    }

    private withinBudget(attemptId: string, level: LogLevel): boolean {
        if (level === 'warn' || level === 'error') {
            return true;
        }

        const state = this.budgets.get(attemptId) ?? {
            debug: 0,
            info: 0,
            budgetWarningEmitted: false,
        };

        if (level === 'debug') {
            state.debug += 1;
        } else {
            state.info += 1;
        }

        const exceeds = state.debug > this.debugBudget || state.info > this.infoBudget;
        if (exceeds) {
            if (!state.budgetWarningEmitted) {
                state.budgetWarningEmitted = true;
                logger.warn('log_budget_exceeded', {
                    attemptId,
                    debugCount: state.debug,
                    infoCount: state.info,
                });
            }
            this.budgets.set(attemptId, state);
            return false;
        }

        this.budgets.set(attemptId, state);
        return true;
    }

    private shouldEmit(key: string): boolean {
        const now = Date.now();
        const existing = this.dedupeCache.get(key);
        if (existing && now - existing.lastAt < this.dedupeTtlMs) {
            return false;
        }
        this.dedupeCache.set(key, { lastAt: now });

        if (this.dedupeCache.size > 1000) {
            const oldest = [...this.dedupeCache.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt).slice(0, 200);
            for (const [entryKey] of oldest) {
                this.dedupeCache.delete(entryKey);
            }
        }

        return true;
    }
}
