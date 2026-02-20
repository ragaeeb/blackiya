import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { buildLoggerMock, createLoggerCalls } from '@/utils/runner/__tests__/helpers';
import { isStaleAttemptMessage, type StaleAttemptFilterDeps } from '@/utils/runner/stale-attempt-filter';

const logCalls = createLoggerCalls();
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));

describe('stale-attempt-filter', () => {
    let deps: StaleAttemptFilterDeps;

    beforeEach(() => {
        deps = {
            resolveAliasedAttemptId: mock((id) => id),
            isAttemptDisposedOrSuperseded: mock(() => false),
            attemptByConversation: new Map(),
            structuredLogger: { emit: mock(() => {}) } as any,
        };
    });

    it('should resolve alias and log if changed but attempt valid', () => {
        deps.resolveAliasedAttemptId = mock((id) => (id === 'alias' ? 'canonical' : id));
        deps.attemptByConversation.set('conv-1', 'canonical');

        const result = isStaleAttemptMessage('alias', 'conv-1', 'lifecycle', deps);

        expect(result).toBeFalse();
        expect(deps.structuredLogger.emit).toHaveBeenCalledWith(
            'canonical',
            'debug',
            'attempt_alias_forwarded',
            expect.any(String),
            expect.objectContaining({ originalAttemptId: 'alias', canonicalAttemptId: 'canonical' }),
            expect.any(String),
        );
    });

    it('should return true if attempt is disposed or superseded', () => {
        deps.isAttemptDisposedOrSuperseded = mock((id) => id === 'attempt-1');

        const result = isStaleAttemptMessage('attempt-1', 'conv-1', 'delta', deps);

        expect(result).toBeTrue();
        expect(deps.structuredLogger.emit).toHaveBeenCalledWith(
            'attempt-1',
            'debug',
            'late_signal_dropped_after_dispose',
            expect.any(String),
            expect.objectContaining({ reason: 'disposed_or_superseded' }),
            expect.any(String),
        );
    });

    it('should return true if attempt does not match conversation registry', () => {
        deps.attemptByConversation.set('conv-1', 'attempt-2');

        const result = isStaleAttemptMessage('attempt-1', 'conv-1', 'finished', deps);

        expect(result).toBeTrue();
        expect(deps.structuredLogger.emit).toHaveBeenCalledWith(
            'attempt-1',
            'debug',
            'stale_signal_ignored',
            expect.any(String),
            expect.objectContaining({ reason: 'conversation_mismatch', activeAttemptId: 'attempt-2' }),
            expect.any(String),
        );
    });

    it('should return false if attempt is valid and matches', () => {
        deps.attemptByConversation.set('conv-1', 'attempt-1');

        const result = isStaleAttemptMessage('attempt-1', 'conv-1', 'finished', deps);
        expect(result).toBeFalse();
        expect(deps.structuredLogger.emit).not.toHaveBeenCalled();
    });
});
