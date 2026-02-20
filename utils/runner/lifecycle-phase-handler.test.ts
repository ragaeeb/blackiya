import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { buildLoggerMock, createLoggerCalls } from '@/utils/runner/__tests__/helpers';
import {
    applyActiveLifecyclePhase,
    applyLifecyclePhaseForConversation,
    type LifecyclePhaseHandlerDeps,
} from '@/utils/runner/lifecycle-phase-handler';
import type { ExportMeta } from '@/utils/sfe/types';

const logCalls = createLoggerCalls();
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));
mock.module('@/utils/runner/stream-preview', () => ({
    ensureLiveRunnerStreamPreview: mock(() => {}),
}));

describe('lifecycle-phase-handler', () => {
    let deps: LifecyclePhaseHandlerDeps;

    beforeEach(() => {
        logCalls.debug.length = 0;
        logCalls.info.length = 0;
        logCalls.warn.length = 0;
        logCalls.error.length = 0;

        deps = {
            getLifecycleState: mock(() => 'idle'),
            getLifecycleConversationId: mock(() => 'conv-1'),
            getLifecycleAttemptId: mock(() => 'attempt-1'),
            setLifecycleAttemptId: mock(() => {}),
            setLifecycleConversationId: mock(() => {}),
            setLifecycleState: mock(() => {}),
            streamPreviewState: {} as any,
            liveStreamPreviewByConversation: new Map(),
            setStreamProbePanel: mock(() => {}),
            ingestSfeLifecycleFromWirePhase: mock(() => {}),
            sfeEnabled: mock(() => true),
            sfeResolve: mock(() => ({ ready: false, phase: 'canonical_probing', blockingConditions: [] })),
            getCaptureMeta: mock(
                () => ({ captureSource: 'canonical_api', fidelity: 'high', completeness: 'complete' }) as ExportMeta,
            ),
            shouldIngestAsCanonicalSample: mock(() => false),
            scheduleCanonicalStabilizationRetry: mock(() => {}),
            runStreamDoneProbe: mock(() => {}),
        };
    });

    describe('applyActiveLifecyclePhase', () => {
        it('should block regression from completed to streaming for same identity', () => {
            deps.getLifecycleState = () => 'completed';
            applyActiveLifecyclePhase('streaming', 'attempt-1', 'conv-1', 'direct', deps);

            expect(logCalls.info).toContainEqual(
                expect.objectContaining({ message: expect.stringMatching(/regression blocked/i) }),
            );
            expect(deps.setLifecycleState).not.toHaveBeenCalled();
        });

        it('should allow phase if different attempt', () => {
            deps.getLifecycleState = () => 'completed';
            applyActiveLifecyclePhase('streaming', 'attempt-2', 'conv-1', 'direct', deps);

            expect(deps.setLifecycleState).toHaveBeenCalledWith('streaming', 'conv-1');
        });

        it('should setup stream preview if not present in active map', () => {
            deps.getLifecycleState = () => 'idle';
            applyActiveLifecyclePhase('prompt-sent', 'attempt-1', 'conv-1', 'direct', deps);

            // Implicit test for ensureLiveRunnerStreamPreview being covered by proxy via mocked modules.
            expect(deps.setStreamProbePanel).toHaveBeenCalledWith('stream: awaiting delta', 'conversationId=conv-1');
            expect(deps.setLifecycleAttemptId).toHaveBeenCalledWith('attempt-1');
            expect(deps.setLifecycleConversationId).toHaveBeenCalledWith('conv-1');
            expect(deps.setLifecycleState).toHaveBeenCalledWith('prompt-sent', 'conv-1');
        });

        it('should skip stream preview initialization if already present in map', () => {
            deps.liveStreamPreviewByConversation.set('conv-1', 'true');
            applyActiveLifecyclePhase('streaming', 'attempt-1', 'conv-1', 'direct', deps);

            expect(deps.setStreamProbePanel).not.toHaveBeenCalled();
            expect(deps.setLifecycleState).toHaveBeenCalledWith('streaming', 'conv-1');
        });
    });

    describe('applyLifecyclePhaseForConversation', () => {
        it('should ingest SFE lifecycle and delegates active phases', () => {
            applyLifecyclePhaseForConversation('prompt-sent', 'ChatGPT', 'attempt-1', 'conv-1', 'direct', deps);

            expect(deps.ingestSfeLifecycleFromWirePhase).toHaveBeenCalledWith('prompt-sent', 'attempt-1', 'conv-1');
            expect(deps.setLifecycleState).toHaveBeenCalledWith('prompt-sent', 'conv-1');
        });

        it('should handle completed phase without SFE by running stream done probe directly', () => {
            deps.sfeEnabled = () => false;
            applyLifecyclePhaseForConversation('completed', 'ChatGPT', 'attempt-1', 'conv-1', 'direct', deps);

            expect(deps.setLifecycleState).toHaveBeenCalledWith('completed', 'conv-1');
            expect(deps.runStreamDoneProbe).toHaveBeenCalledWith('conv-1', 'attempt-1');
            expect(deps.scheduleCanonicalStabilizationRetry).not.toHaveBeenCalled();
        });

        it('should run probe but skip retry schedule if already stabilized', () => {
            deps.sfeEnabled = () => true;
            deps.sfeResolve = () => ({ ready: true, phase: 'completed', blockingConditions: [] });

            applyLifecyclePhaseForConversation('completed', 'ChatGPT', 'attempt-1', 'conv-1', 'direct', deps);

            expect(deps.scheduleCanonicalStabilizationRetry).not.toHaveBeenCalled();
            expect(deps.runStreamDoneProbe).toHaveBeenCalledWith('conv-1', 'attempt-1');
        });

        it('should schedule canonical stabilization retry if conditions met', () => {
            deps.sfeEnabled = () => true;
            deps.sfeResolve = () => ({ ready: false, phase: 'canonical_probing', blockingConditions: [] });

            applyLifecyclePhaseForConversation('completed', 'ChatGPT', 'attempt-1', 'conv-1', 'direct', deps);

            expect(deps.scheduleCanonicalStabilizationRetry).toHaveBeenCalledWith('conv-1', 'attempt-1');
            expect(deps.runStreamDoneProbe).toHaveBeenCalledWith('conv-1', 'attempt-1');
        });

        it('should not schedule stabilization retry if timed out in conditions', () => {
            deps.sfeEnabled = () => true;
            deps.sfeResolve = () => ({
                ready: false,
                phase: 'canonical_probing',
                blockingConditions: ['stabilization_timeout'],
            });

            applyLifecyclePhaseForConversation('completed', 'ChatGPT', 'attempt-1', 'conv-1', 'direct', deps);

            expect(deps.scheduleCanonicalStabilizationRetry).not.toHaveBeenCalled();
        });
    });
});
