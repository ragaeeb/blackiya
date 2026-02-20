import { describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import {
    buildBrowserMock,
    buildLoggerMock,
    createLoggerCalls,
    createMockAdapter,
    setupHappyDomGlobals,
} from './runner/__tests__/helpers';

// Configure Happy DOM
const window = new Window();
const document = setupHappyDomGlobals(window as any);

// We need a mutable reference to control the mock return value
const currentAdapterMock: any = createMockAdapter(document);
const browserMockState = {
    storageData: {} as Record<string, unknown>,
    sendMessage: async (_message: unknown) => undefined as unknown,
};
const loggerCalls = createLoggerCalls();

// Mock the factory module
mock.module('@/platforms/factory', () => ({
    getPlatformAdapter: () => currentAdapterMock,
    getPlatformAdapterByApiUrl: () => currentAdapterMock,
}));

const downloadCalls: Array<{ data: unknown; filename: string }> = [];
mock.module('@/utils/download', () => ({
    downloadAsJSON: (data: unknown, filename: string) => {
        downloadCalls.push({ data, filename });
    },
}));

mock.module('@/utils/logger', () => buildLoggerMock(loggerCalls));

// Mock wxt/browser explicitly for this test file to prevent logger errors
mock.module('wxt/browser', () => buildBrowserMock(browserMockState));

// Import subject under test AFTER mocking
import {
    beginCanonicalStabilizationTick,
    clearCanonicalStabilizationAttemptState,
    resolveShouldSkipCanonicalRetryAfterAwait,
    shouldRemoveDisposedAttemptBinding,
} from '@/utils/runner/platform-runtime';

describe('shouldRemoveDisposedAttemptBinding', () => {
    const resolveFromMap = (aliases: Record<string, string>) => (attemptId: string) => {
        let current = attemptId;
        const visited = new Set<string>();
        while (aliases[current] && !visited.has(current)) {
            visited.add(current);
            current = aliases[current];
        }
        return current;
    };

    it('removes mapped attempts that resolve to disposed canonical attempt', () => {
        const resolve = resolveFromMap({
            'attempt:raw-a': 'attempt:raw-b',
            'attempt:raw-b': 'attempt:canonical-c',
        });
        expect(shouldRemoveDisposedAttemptBinding('attempt:raw-a', 'attempt:raw-b', resolve)).toBeTrue();
    });

    it('keeps mapped attempts that resolve to a different canonical attempt', () => {
        const resolve = resolveFromMap({
            'attempt:raw-a': 'attempt:canonical-a',
            'attempt:raw-b': 'attempt:canonical-b',
        });
        expect(shouldRemoveDisposedAttemptBinding('attempt:raw-a', 'attempt:raw-b', resolve)).toBeFalse();
    });
});

describe('canonical stabilization retry helpers', () => {
    it('allows only one in-flight retry tick per attempt', () => {
        const inProgress = new Set<string>();
        expect(beginCanonicalStabilizationTick('attempt-1', inProgress)).toBeTrue();
        expect(beginCanonicalStabilizationTick('attempt-1', inProgress)).toBeFalse();
        expect(inProgress.has('attempt-1')).toBeTrue();
    });

    it('clears retry timer/count/start/timeout state in one call', () => {
        const timerIds = new Map<string, number>([['attempt-1', 101]]);
        const retryCounts = new Map<string, number>([['attempt-1', 3]]);
        const startedAt = new Map<string, number>([['attempt-1', 999]]);
        const timeoutWarnings = new Set<string>(['attempt-1']);
        const inProgress = new Set<string>(['attempt-1']);
        const clearedTimers: number[] = [];

        clearCanonicalStabilizationAttemptState(
            'attempt-1',
            {
                timerIds,
                retryCounts,
                startedAt,
                timeoutWarnings,
                inProgress,
            },
            (timerId: any) => {
                clearedTimers.push(timerId);
            },
        );

        expect(clearedTimers).toEqual([101]);
        expect(timerIds.has('attempt-1')).toBeFalse();
        expect(retryCounts.has('attempt-1')).toBeFalse();
        expect(startedAt.has('attempt-1')).toBeFalse();
        expect(timeoutWarnings.has('attempt-1')).toBeFalse();
        expect(inProgress.has('attempt-1')).toBeFalse();
    });

    it('re-checks disposal and conversation mismatch after await boundaries', () => {
        const disposed = resolveShouldSkipCanonicalRetryAfterAwait(
            'attempt-1',
            true,
            undefined,
            (attemptId: any) => attemptId,
        );
        expect(disposed).toBeTrue();

        const mismatched = resolveShouldSkipCanonicalRetryAfterAwait(
            'attempt-1',
            false,
            'attempt-2',
            (attemptId: any) => attemptId,
        );
        expect(mismatched).toBeTrue();

        const canonicalAliasMatch = resolveShouldSkipCanonicalRetryAfterAwait(
            'attempt-1',
            false,
            'alias-attempt-1',
            (attemptId: any) => (attemptId === 'alias-attempt-1' ? 'attempt-1' : attemptId),
        );
        expect(canonicalAliasMatch).toBeFalse();
    });
});
