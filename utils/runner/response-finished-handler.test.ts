import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { buildLoggerMock, createLoggerCalls } from '@/utils/runner/__tests__/helpers';
import * as finishedSignal from '@/utils/runner/finished-signal';
import {
    processFinishedConversation,
    processResponseFinished,
    type ResponseFinishedDeps,
    shouldProcessFinishedSignal,
} from '@/utils/runner/response-finished-handler';

const logCalls = createLoggerCalls();
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));

describe('response-finished-handler', () => {
    let deps: ResponseFinishedDeps;
    let debounceSpy: ReturnType<typeof spyOn>;
    let promoteSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        logCalls.debug.length = 0;
        logCalls.info.length = 0;
        logCalls.warn.length = 0;
        logCalls.error.length = 0;

        debounceSpy = spyOn(finishedSignal, 'resolveFinishedSignalDebounce').mockReturnValue({
            minIntervalMs: 1000,
            effectiveAttemptId: 'eff-id',
        });
        promoteSpy = spyOn(finishedSignal, 'shouldPromoteGrokFromCanonicalCapture').mockReturnValue(false);

        deps = {
            extractConversationIdFromUrl: mock(() => null),
            getCurrentConversationId: mock(() => 'conv-1'),
            peekAttemptId: mock(() => 'attempt-1'),
            resolveAttemptId: mock(() => 'attempt-1'),
            setActiveAttempt: mock(() => {}),
            setCurrentConversation: mock(() => {}),
            bindAttempt: mock(() => {}),
            ingestSfeLifecycle: mock(() => {}),
            getCalibrationState: mock(() => 'idle' as any),
            shouldBlockActionsForGeneration: mock(() => false),
            adapterName: mock(() => 'ChatGPT'),

            getLastResponseFinished: mock(() => ({
                at: Date.now() - 2000,
                conversationId: 'conv-1',
                attemptId: 'attempt-1',
            })),
            setLastResponseFinished: mock(() => {}),

            getConversation: mock(() => ({}) as any),
            evaluateReadiness: mock(() => ({ ready: true, terminal: false, reason: '' }) as any),
            getLifecycleState: mock(() => 'streaming' as any),
            setCompletedLifecycleState: mock(() => {}),
            runStreamDoneProbe: mock(() => Promise.resolve()),
            refreshButtonState: mock(() => {}),
            scheduleButtonRefresh: mock(() => {}),
            maybeRunAutoCapture: mock(() => {}),
        };
    });

    afterEach(() => {
        debounceSpy.mockRestore();
        promoteSpy.mockRestore();
    });

    describe('shouldProcessFinishedSignal', () => {
        it('should block if no conversation', () => {
            expect(shouldProcessFinishedSignal(null, 'dom', 'a-1', deps)).toBeFalse();
        });

        it('should block if ChatGPT network signal but generation blocked', () => {
            deps.shouldBlockActionsForGeneration = () => true;
            expect(shouldProcessFinishedSignal('c-1', 'network', 'a-1', deps)).toBeFalse();
        });

        it('should block if debounced', () => {
            deps.getLastResponseFinished = () => ({ at: Date.now() - 500, conversationId: 'c-1', attemptId: 'a-1' });
            expect(shouldProcessFinishedSignal('c-1', 'dom', 'a-1', deps)).toBeFalse();
        });

        it('should return true if past debounce threshold and set state', () => {
            deps.getLastResponseFinished = () => ({ at: Date.now() - 2000, conversationId: 'c-1', attemptId: 'a-1' });
            expect(shouldProcessFinishedSignal('c-1', 'dom', 'a-1', deps)).toBeTrue();
            expect(deps.setLastResponseFinished).toHaveBeenCalled();
        });
    });

    describe('processFinishedConversation', () => {
        it('should promote chatgpt dom generic completed and set state', () => {
            deps.adapterName = () => 'ChatGPT';
            processFinishedConversation('c-1', 'a-1', 'dom', deps);

            expect(deps.setCompletedLifecycleState).toHaveBeenCalledWith('c-1', 'a-1');
            expect(deps.refreshButtonState).toHaveBeenCalledWith('c-1');
            expect(deps.scheduleButtonRefresh).toHaveBeenCalledWith('c-1');
            expect(deps.maybeRunAutoCapture).toHaveBeenCalledWith('c-1', 'response-finished');
        });

        it('should run probe if not cached ready', () => {
            deps.evaluateReadiness = () => ({ ready: false, terminal: false, reason: '' }) as any;
            deps.adapterName = () => 'Grok';
            processFinishedConversation('c-1', 'a-1', 'network', deps);

            expect(deps.setCompletedLifecycleState).toHaveBeenCalledWith('c-1', 'a-1');
            expect(deps.runStreamDoneProbe).toHaveBeenCalledWith('c-1', 'a-1');
        });
    });

    describe('processResponseFinished', () => {
        it('should safely abort if shouldProcessFinishedSignal is false', () => {
            deps.getCurrentConversationId = () => null;
            processResponseFinished('network', undefined, deps);
            expect(deps.setActiveAttempt).not.toHaveBeenCalled();
        });

        it('should set attempt state, ingest sfe, trigger finished hook if passes', () => {
            processResponseFinished('network', undefined, deps);

            expect(deps.setActiveAttempt).toHaveBeenCalledWith('attempt-1');
            expect(deps.ingestSfeLifecycle).toHaveBeenCalledWith('completed_hint', 'attempt-1', 'conv-1');
            expect(deps.setCurrentConversation).toHaveBeenCalledWith('conv-1');
            expect(deps.bindAttempt).toHaveBeenCalledWith('conv-1', 'attempt-1');
            // implicit processFinishedConversation call since state is idle
            expect(deps.maybeRunAutoCapture).toHaveBeenCalled();
        });

        it('should abort hooks early if calibration state is waiting', () => {
            deps.getCalibrationState = () => 'waiting';
            processResponseFinished('network', undefined, deps);
            // The processFinishedConversation would invoke maybeRunAutoCapture, which should be skipped
            expect(deps.maybeRunAutoCapture).not.toHaveBeenCalled();
        });
    });
});
