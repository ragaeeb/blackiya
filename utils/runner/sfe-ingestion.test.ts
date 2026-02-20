import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { buildLoggerMock, createLoggerCalls } from '@/utils/runner/__tests__/helpers';
import {
    emitAttemptDisposed,
    ingestSfeCanonicalSample,
    ingestSfeLifecycleFromWirePhase,
    logSfeMismatchIfNeeded,
    maybeReingestCachedCanonical,
    resolveSfeReady,
} from '@/utils/runner/sfe-ingestion';

const logCalls = createLoggerCalls();
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));

describe('sfe-ingestion', () => {
    let deps: any;

    beforeEach(() => {
        logCalls.debug.length = 0;
        logCalls.info.length = 0;
        logCalls.warn.length = 0;
        logCalls.error.length = 0;

        deps = {
            sfeEnabled: true,
            sfe: {
                ingestSignal: mock(() => ({ phase: 'completed_hint', ready: true })),
                applyCanonicalSample: mock(() => ({
                    phase: 'completed_hint',
                    ready: true,
                    blockingConditions: [],
                    reason: 'captured_ready',
                })),
                resolveByConversation: mock(() => ({ ready: true })),
            },
            platformName: 'ChatGPT',
            resolveAttemptId: mock(() => 'attempt-1'),
            bindAttempt: mock(() => {}),
            evaluateReadiness: mock(() => ({ contentHash: 'abc', terminal: true }) as any),
            getLifecycleState: mock(() => 'completed'),
            scheduleCanonicalStabilizationRetry: mock(() => {}),
            clearCanonicalStabilizationRetry: mock(() => {}),
            syncStreamProbePanelFromCanonical: mock(() => {}),
            refreshButtonState: mock(() => {}),
            structuredLogger: { emit: mock(() => {}) } as any,
        };
    });

    describe('ingestSfeLifecycleFromWirePhase', () => {
        it('should ingest valid phases', () => {
            ingestSfeLifecycleFromWirePhase('completed', 'attempt-1', 'conv-1', deps);
            expect(deps.sfe.ingestSignal).toHaveBeenCalledWith(
                expect.objectContaining({ phase: 'completed_hint', attemptId: 'attempt-1' }),
            );
            expect(deps.bindAttempt).toHaveBeenCalledWith('conv-1', 'attempt-1');
        });

        it('should do nothing for invalid phases', () => {
            ingestSfeLifecycleFromWirePhase('unknown' as any, 'attempt-1', 'conv-1', deps);
            expect(deps.sfe.ingestSignal).not.toHaveBeenCalled();
            expect(deps.bindAttempt).not.toHaveBeenCalled();
        });
    });

    describe('ingestSfeCanonicalSample', () => {
        it('should return null if SFE disabled', () => {
            deps.sfeEnabled = false;
            const result = ingestSfeCanonicalSample({} as any, undefined, deps);
            expect(result).toBeNull();
            expect(deps.sfe.applyCanonicalSample).not.toHaveBeenCalled();
        });

        it('should ingest and check for stabilization', () => {
            deps.sfe.applyCanonicalSample.mockImplementationOnce(() => ({
                phase: 'completed_hint',
                ready: false,
                blockingConditions: [],
                reason: 'awaiting_stabilization',
            }));
            const result = ingestSfeCanonicalSample({ conversation_id: 'conv-1' } as any, undefined, deps);

            expect(result?.ready).toBeFalse();
            expect(deps.bindAttempt).toHaveBeenCalledWith('conv-1', 'attempt-1');
            expect(deps.scheduleCanonicalStabilizationRetry).toHaveBeenCalledWith('conv-1', 'attempt-1');
        });

        it('should clear retry timeouts when ready', () => {
            ingestSfeCanonicalSample({ conversation_id: 'conv-1' } as any, 'explicit-attempt', deps);

            expect(deps.bindAttempt).toHaveBeenCalledWith('conv-1', 'explicit-attempt');
            expect(deps.clearCanonicalStabilizationRetry).toHaveBeenCalledWith('explicit-attempt');
            expect(deps.syncStreamProbePanelFromCanonical).toHaveBeenCalled();
        });
    });

    describe('logSfeMismatchIfNeeded', () => {
        it('should log mismatch if legacy does not equal SFE readiness', () => {
            deps.peekAttemptId = mock(() => 'attempt-1');
            logSfeMismatchIfNeeded('conv-1', false, deps);

            expect(deps.structuredLogger.emit).toHaveBeenCalledWith(
                'attempt-1',
                'info',
                'legacy_sfe_mismatch',
                expect.any(String),
                expect.objectContaining({ conversationId: 'conv-1', legacyReady: false, sfeReady: true }),
                expect.any(String),
            );
        });

        it('should not log if they match', () => {
            deps.peekAttemptId = mock(() => 'attempt-1');
            logSfeMismatchIfNeeded('conv-1', true, deps);
            expect(deps.structuredLogger.emit).not.toHaveBeenCalled();
        });
    });

    describe('emitAttemptDisposed', () => {
        it('should remove lifecycle pending state and structure log', () => {
            const depsOverride = {
                pendingLifecycleByAttempt: new Map([['attempt-1', 'something']]),
                structuredLogger: deps.structuredLogger,
                postDisposedMessage: mock(() => {}),
            };

            emitAttemptDisposed('attempt-1', 'superseded', depsOverride);

            expect(depsOverride.pendingLifecycleByAttempt.has('attempt-1')).toBeFalse();
            expect(depsOverride.postDisposedMessage).toHaveBeenCalledWith('attempt-1', 'superseded');
            expect(depsOverride.structuredLogger.emit).toHaveBeenCalled();
        });
    });
});
