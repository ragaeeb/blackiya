import { describe, expect, it, mock } from 'bun:test';
import {
    beginCanonicalStabilizationTick,
    type CanonicalStabilizationAttemptState,
    clearCanonicalStabilizationAttemptState,
    resolveShouldSkipCanonicalRetryAfterAwait,
} from '@/utils/runner/canonical-stabilization';

describe('canonical-stabilization', () => {
    describe('beginCanonicalStabilizationTick', () => {
        it('should return true and add attempt if not in progress', () => {
            const inProgress = new Set<string>();
            const result = beginCanonicalStabilizationTick('attempt-1', inProgress);
            expect(result).toBeTrue();
            expect(inProgress.has('attempt-1')).toBeTrue();
        });

        it('should return false if already in progress', () => {
            const inProgress = new Set(['attempt-1']);
            const result = beginCanonicalStabilizationTick('attempt-1', inProgress);
            expect(result).toBeFalse();
        });
    });

    describe('clearCanonicalStabilizationAttemptState', () => {
        it('should clear all state for the attempt', () => {
            const state: CanonicalStabilizationAttemptState = {
                timerIds: new Map([['attempt-1', 123]]),
                retryCounts: new Map([['attempt-1', 2]]),
                startedAt: new Map([['attempt-1', 1000]]),
                timeoutWarnings: new Set(['attempt-1']),
                inProgress: new Set(['attempt-1']),
            };

            const clearTimerMock = mock((_id) => {});
            clearCanonicalStabilizationAttemptState('attempt-1', state, clearTimerMock);

            expect(clearTimerMock).toHaveBeenCalledWith(123);
            expect(state.timerIds.has('attempt-1')).toBeFalse();
            expect(state.retryCounts.has('attempt-1')).toBeFalse();
            expect(state.startedAt.has('attempt-1')).toBeFalse();
            expect(state.timeoutWarnings.has('attempt-1')).toBeFalse();
            expect(state.inProgress.has('attempt-1')).toBeFalse();
        });

        it('should handle attempt not having state without throwing', () => {
            const state: CanonicalStabilizationAttemptState = {
                timerIds: new Map(),
                retryCounts: new Map(),
                startedAt: new Map(),
                timeoutWarnings: new Set(),
                inProgress: new Set(),
            };

            const clearTimerMock = mock((_id) => {});
            clearCanonicalStabilizationAttemptState('attempt-1', state, clearTimerMock);

            expect(clearTimerMock).not.toHaveBeenCalled();
            expect(state.timerIds.has('attempt-1')).toBeFalse();
        });
    });

    describe('resolveShouldSkipCanonicalRetryAfterAwait', () => {
        it('should return true if disposed or superseded', () => {
            const result = resolveShouldSkipCanonicalRetryAfterAwait('attempt-1', true, undefined, (id) => id);
            expect(result).toBeTrue();
        });

        it('should return false if mapped attempt is undefined', () => {
            const result = resolveShouldSkipCanonicalRetryAfterAwait('attempt-1', false, undefined, (id) => id);
            expect(result).toBeFalse();
        });

        it('should return true if mapped attempt does not match canonical identity', () => {
            const result = resolveShouldSkipCanonicalRetryAfterAwait('attempt-1', false, 'attempt-2', (id) => id);
            expect(result).toBeTrue();
        });

        it('should return false if mapped attempt matches canonical identity', () => {
            const result = resolveShouldSkipCanonicalRetryAfterAwait('attempt-1', false, 'attempt-alias', (id) => {
                return id === 'attempt-alias' ? 'attempt-1' : id;
            });
            expect(result).toBeFalse();
        });
    });
});
