import { describe, expect, it, mock } from 'bun:test';

const emitted: Array<{ level: string; message: string }> = [];

mock.module('@/utils/logger', () => ({
    logger: {
        debug: (message: string) => emitted.push({ level: 'debug', message }),
        info: (message: string) => emitted.push({ level: 'info', message }),
        warn: (message: string) => emitted.push({ level: 'warn', message }),
        error: (message: string) => emitted.push({ level: 'error', message }),
    },
}));

import { StructuredAttemptLogger } from '@/utils/logging/structured-logger';

describe('StructuredAttemptLogger', () => {
    it('dedupes and enforces budgets', () => {
        emitted.length = 0;
        const logger = new StructuredAttemptLogger({ debugBudget: 1, infoBudget: 1, dedupeTtlMs: 5000 });

        logger.emit('a1', 'info', 'event', 'hello', {}, 'k1');
        logger.emit('a1', 'info', 'event', 'hello', {}, 'k1');
        logger.emit('a1', 'info', 'event2', 'world', {}, 'k2');

        expect(emitted.filter((e) => e.level === 'info').length).toBe(1);
        expect(emitted.some((e) => e.message === 'log_budget_exceeded')).toBeTrue();
    });
});
