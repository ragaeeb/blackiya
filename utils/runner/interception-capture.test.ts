import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { processInterceptionCapture } from '@/utils/runner/interception-capture';

describe('interception-capture', () => {
    describe('processInterceptionCapture', () => {
        let deps: any;
        beforeEach(() => {
            deps = {
                getStreamResolvedTitle: mock(() => undefined),
                setCurrentConversation: mock(() => {}),
                setActiveAttempt: mock(() => {}),
                bindAttempt: mock(() => {}),
                peekAttemptId: mock(() => 'a-1'),
                resolveAttemptId: mock((c: string) => `r-${c}`),
                resolveAliasedAttemptId: mock((a: string) => `aliased-${a}`),
                evaluateReadinessForData: mock(() => ({ ready: true })),
                resolveReadinessDecision: mock(() => ({ mode: 'pending' })),
                markSnapshotCaptureMeta: mock(() => {}),
                markCanonicalCaptureMeta: mock(() => {}),
                ingestSfeCanonicalSample: mock(() => {}),
                maybeRestartCanonicalRecoveryAfterTimeout: mock(() => {}),
                scheduleCanonicalStabilizationRetry: mock(() => {}),
                refreshButtonState: mock(() => {}),
                handleResponseFinished: mock(() => {}),
                getLifecycleState: mock(() => 'streaming'),
                structuredLogger: { emit: mock(() => {}) },
            };
        });

        it('should apply stream resolved title and bind attempts', () => {
            deps.getStreamResolvedTitle.mockReturnValueOnce('Stream Title');
            const data: any = { title: 'Old Title' };

            processInterceptionCapture('c-1', data, { attemptId: 'a-2' }, deps);

            expect(data.title).toBe('Stream Title');
            expect(deps.setCurrentConversation).toHaveBeenCalledWith('c-1');
            expect(deps.setActiveAttempt).toHaveBeenCalledWith('a-2');
            expect(deps.bindAttempt).toHaveBeenCalledWith('c-1', 'a-2');
        });

        it('should process snapshot capture logic correctly', () => {
            processInterceptionCapture('c-1', {} as any, { source: 'snapshot-fallback' }, deps);

            expect(deps.markSnapshotCaptureMeta).toHaveBeenCalledWith('c-1');
            expect(deps.structuredLogger.emit).toHaveBeenCalledWith(
                'a-1',
                'info',
                'snapshot_degraded_mode_used',
                expect.any(String),
                expect.any(Object),
                expect.any(String),
            );
        });

        it('should mark canonical meta on snapshot if decision is canonial_ready', () => {
            deps.resolveReadinessDecision.mockReturnValue({ mode: 'canonical_ready' });
            processInterceptionCapture('c-1', {} as any, { source: 'snapshot-fallback' }, deps);

            expect(deps.markCanonicalCaptureMeta).toHaveBeenCalledWith('c-1');
            expect(deps.markSnapshotCaptureMeta).not.toHaveBeenCalled();
        });

        it('should schedule canonical retry on snapshot capture if lifecycle completed', () => {
            deps.getLifecycleState.mockReturnValue('completed');
            processInterceptionCapture('c-1', {} as any, { source: 'snapshot-fallback' }, deps);
            expect(deps.scheduleCanonicalStabilizationRetry).toHaveBeenCalledWith('c-1', 'a-1');
        });

        it('should process network source explicitly and trigger canonical flows', () => {
            processInterceptionCapture('c-1', { data: 123 } as any, { source: 'network', attemptId: 'a-2' }, deps);

            expect(deps.markCanonicalCaptureMeta).toHaveBeenCalledWith('c-1');
            expect(deps.ingestSfeCanonicalSample).toHaveBeenCalledWith({ data: 123 }, 'aliased-a-2');
            expect(deps.handleResponseFinished).toHaveBeenCalledWith('network', 'c-1');
            expect(deps.refreshButtonState).toHaveBeenCalledWith('c-1');
        });
    });
});
