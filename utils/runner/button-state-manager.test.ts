import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { LLMPlatform } from '@/platforms/types';
import { buildLoggerMock, createLoggerCalls } from '@/utils/runner/__tests__/helpers';
import {
    type ButtonStateManagerDeps,
    injectSaveButton,
    isConversationReadyForActions,
    logButtonStateIfChanged,
    refreshButtonState,
    resolveReadinessDecision,
    scheduleButtonRefresh,
} from '@/utils/runner/button-state-manager';
import type { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';

const logCalls = createLoggerCalls();
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));

describe('button-state-manager', () => {
    let deps: ButtonStateManagerDeps;
    let originalSetTimeout: typeof setTimeout;
    let mockAdapter: LLMPlatform;
    let lastButtonStateLog: { value: string };

    beforeEach(() => {
        logCalls.debug.length = 0;
        logCalls.info.length = 0;
        logCalls.warn.length = 0;
        logCalls.error.length = 0;

        (globalThis as any).window = {
            location: { href: 'https://chat.openai.com/c/123' },
        };

        originalSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = mock((_fn) => {
            // Do NOT automatically call fn for scheduleButtonRefresh else it infinite loops
            return 123 as any;
        }) as any;

        mockAdapter = {
            name: 'ChatGPT',
            extractConversationId: mock(() => '123'),
            getButtonInjectionTarget: mock(() => ({}) as unknown as Element),
        } as unknown as LLMPlatform;

        deps = {
            getAdapter: mock(() => mockAdapter),
            getCurrentConversationId: mock(() => '123'),
            getLifecycleState: mock(() => 'completed' as const),
            getCalibrationState: mock(() => 'idle' as const),
            setCalibrationState: mock(() => {}),
            getRememberedPreferredStep: mock(() => null),
            getRememberedCalibrationUpdatedAt: mock(() => null),
            sfeEnabled: mock(() => true),
            sfe: {
                resolveByConversation: mock(
                    () => ({ ready: true, reason: 'canonical_ready', blockingConditions: [] }) as any,
                ),
            } as unknown as SignalFusionEngine,
            attemptByConversation: new Map([['123', 'attempt-1']]),
            captureMetaByConversation: new Map(),
            lastCanonicalReadyLogAtByConversation: new Map(),
            timeoutWarningByAttempt: new Set(),
            maxConversationAttempts: 10,
            maxAutocaptureKeys: 10,
            canonicalReadyLogTtlMs: 60000,

            getConversation: mock(() => ({ conversation_id: '123' }) as any),
            evaluateReadinessForData: mock(() => ({ ready: true, terminal: true, reason: 'term' }) as any),
            peekAttemptId: mock(() => 'attempt-1'),
            hasCanonicalStabilizationTimedOut: mock(() => false),
            logSfeMismatchIfNeeded: mock(() => {}),
            ingestSfeCanonicalSample: mock(() => {}),

            isLifecycleActiveGeneration: mock(() => false),
            shouldBlockActionsForGeneration: mock(() => false),
            setCurrentConversation: mock(() => {}),
            setLifecycleState: mock(() => {}),
            syncCalibrationButtonDisplay: mock(() => {}),
            syncRunnerStateCalibration: mock(() => {}),
            emitExternalConversationEvent: mock(() => {}),

            buttonManager: {
                exists: mock(() => true),
                inject: mock(() => {}),
                setLifecycleState: mock(() => {}),
                setCalibrationState: mock(() => {}),
                setSaveButtonMode: mock(() => {}),
                setActionButtonsEnabled: mock(() => {}),
                setOpacity: mock(() => {}),
                setButtonEnabled: mock(() => {}),
                setReadinessSource: mock(() => {}),
            },

            structuredLogger: {
                emit: mock(() => {}),
            } as any,
        };

        lastButtonStateLog = { value: '' };
    });

    afterEach(() => {
        globalThis.setTimeout = originalSetTimeout;
        delete (globalThis as any).window;
    });

    describe('resolveReadinessDecision', () => {
        it('should calculate resolveRunnerReadinessDecision without throwing', () => {
            // Need to verify standard call properties passed
            const decision = resolveReadinessDecision('123', deps);
            expect(decision).toBeDefined();
        });

        it('should emit timeout warning only once per attempt', () => {
            // Force timeout
            deps.captureMetaByConversation.set('123', {
                captureSource: 'dom_snapshot_degraded',
                fidelity: 'degraded',
                completeness: 'partial',
            });
            deps.hasCanonicalStabilizationTimedOut = () => true;

            resolveReadinessDecision('123', deps);
            expect(deps.structuredLogger.emit).toHaveBeenCalledTimes(1);

            // Call again
            resolveReadinessDecision('123', deps);
            expect(deps.structuredLogger.emit).toHaveBeenCalledTimes(1);
        });

        it('should throttle canonical ready log decisions over TTL', () => {
            deps.structuredLogger.emit = () => {};
            deps.evaluateReadinessForData = () => ({ ready: true, terminal: true, reason: 'terminal' }) as any;

            // Re-bind shouldLogCanonicalReadyDecision inside deps basically works
            resolveReadinessDecision('123', deps);
            // It uses deps.lastCanonicalReadyLogAtByConversation under the hood
            expect(deps.lastCanonicalReadyLogAtByConversation.has('123')).toBeTrue();
        });

        it('should properly clear timeout warnings and canonical ready log stamps', () => {
            deps.timeoutWarningByAttempt.add('attempt-1');
            deps.lastCanonicalReadyLogAtByConversation.set('123', Date.now());

            deps.sfe.resolveByConversation = () =>
                ({ ready: false, reason: 'captured_not_ready', blockingConditions: [] }) as any;
            deps.evaluateReadinessForData = () =>
                ({ ready: false, terminal: false, reason: 'legacy_not_ready' }) as any;
            deps.getConversation = () => null as any;

            resolveReadinessDecision('123', deps);

            expect(deps.timeoutWarningByAttempt.has('attempt-1')).toBeTrue(); // Only cleared if not timeout/cleared by inner logic
            expect(deps.lastCanonicalReadyLogAtByConversation.has('123')).toBeFalse(); // Missing data clears it
        });
    });

    describe('isConversationReadyForActions', () => {
        it('should return true if mode is canonical_ready', () => {
            expect(isConversationReadyForActions('123', {}, deps)).toBeTrue();
        });

        it('should return false if mode is degraded and includeDegraded is false or omitted', () => {
            deps.captureMetaByConversation.set('123', {
                captureSource: 'dom_snapshot_degraded',
                fidelity: 'degraded',
                completeness: 'partial',
            });
            deps.hasCanonicalStabilizationTimedOut = () => true;
            expect(isConversationReadyForActions('123', {}, deps)).toBeFalse();
        });

        it('should return true if mode is degraded and includeDegraded is true', () => {
            deps.captureMetaByConversation.set('123', {
                captureSource: 'dom_snapshot_degraded',
                fidelity: 'degraded',
                completeness: 'partial',
            });
            deps.hasCanonicalStabilizationTimedOut = () => true;
            expect(isConversationReadyForActions('123', { includeDegraded: true }, deps)).toBeTrue();
        });

        it('should return false if mode is not_ready', () => {
            deps.sfe.resolveByConversation = () =>
                ({ ready: false, reason: 'captured_not_ready', blockingConditions: [] }) as any;
            deps.evaluateReadinessForData = () => ({ ready: false, terminal: false, reason: 'in_progress' }) as any;
            expect(isConversationReadyForActions('123', { includeDegraded: true }, deps)).toBeFalse();
        });
    });

    describe('logButtonStateIfChanged', () => {
        it('should log when state changes and update the reference value', () => {
            logButtonStateIfChanged('123', true, '1', lastButtonStateLog, 'completed', deps.getConversation);
            expect(logCalls.info).toHaveLength(1);
            expect(lastButtonStateLog.value).toBe('123:ready:1');
        });

        it('should not log when state is identical to reference', () => {
            lastButtonStateLog.value = '123:ready:1';
            logButtonStateIfChanged('123', true, '1', lastButtonStateLog, 'completed', deps.getConversation);
            expect(logCalls.info).toHaveLength(0);
        });
    });

    describe('refreshButtonState', () => {
        it('should exit and snapshot if adapter is null', () => {
            deps.getAdapter = () => null;
            refreshButtonState('123', deps, lastButtonStateLog);
            expect(deps.buttonManager.setSaveButtonMode).not.toHaveBeenCalled();
        });

        it('should still emit external canonical-ready event when button is not injected', () => {
            deps.buttonManager.exists = () => false;
            refreshButtonState('123', deps, lastButtonStateLog);
            expect(deps.emitExternalConversationEvent).toHaveBeenCalledWith({
                conversationId: '123',
                data: { conversation_id: '123' },
                readinessMode: 'canonical_ready',
                captureMeta: {
                    captureSource: 'canonical_api',
                    fidelity: 'high',
                    completeness: 'complete',
                },
                attemptId: 'attempt-1',
                allowWhenActionsBlocked: true,
            });
        });

        it('should clear UI if no conversation is found in URL and no arg provided', () => {
            mockAdapter.extractConversationId = () => null;
            refreshButtonState(undefined, deps, lastButtonStateLog);
            expect(deps.setCurrentConversation).toHaveBeenCalledWith(null);
            expect(deps.buttonManager.setActionButtonsEnabled).toHaveBeenCalledWith(false);
        });

        it('should disable buttons if actively generating', () => {
            deps.getLifecycleState = () => 'streaming';
            refreshButtonState('123', deps, lastButtonStateLog);
            expect(deps.buttonManager.setActionButtonsEnabled).toHaveBeenCalledWith(false);
            expect(deps.buttonManager.setOpacity).toHaveBeenCalledWith('0.6');
            expect(deps.emitExternalConversationEvent).toHaveBeenCalledWith({
                conversationId: '123',
                data: { conversation_id: '123' },
                readinessMode: 'canonical_ready',
                captureMeta: {
                    captureSource: 'canonical_api',
                    fidelity: 'high',
                    completeness: 'complete',
                },
                attemptId: 'attempt-1',
                allowWhenActionsBlocked: true,
            });
        });

        it('should enable save button in degraded mode', () => {
            // Configure deps so resolveReadinessDecision naturally returns degraded_manual_only:
            // sfe reports timeout via blockingConditions, data exists but not ready
            deps.sfe.resolveByConversation = mock(
                () =>
                    ({
                        ready: false,
                        reason: 'stabilization_timeout',
                        blockingConditions: ['stabilization_timeout'],
                    }) as any,
            );
            deps.evaluateReadinessForData = mock(
                () => ({ ready: false, terminal: false, reason: 'in_progress' }) as any,
            );
            refreshButtonState('123', deps, lastButtonStateLog);
            expect(deps.buttonManager.setSaveButtonMode).toHaveBeenCalledWith('force-degraded');
            expect(deps.buttonManager.setButtonEnabled).toHaveBeenCalledWith('save', true);
            expect(deps.buttonManager.setOpacity).toHaveBeenCalledWith('1');
        });

        it('should enable action buttons in canonical ready mode', () => {
            refreshButtonState('123', deps, lastButtonStateLog);
            expect(deps.buttonManager.setSaveButtonMode).toHaveBeenCalledWith('default');
            expect(deps.buttonManager.setActionButtonsEnabled).toHaveBeenCalledWith(true);
            expect(deps.buttonManager.setOpacity).toHaveBeenCalledWith('1');
            expect(deps.setCalibrationState).toHaveBeenCalledWith('success');
            expect(deps.emitExternalConversationEvent).toHaveBeenCalledWith({
                conversationId: '123',
                data: { conversation_id: '123' },
                readinessMode: 'canonical_ready',
                captureMeta: {
                    captureSource: 'canonical_api',
                    fidelity: 'high',
                    completeness: 'complete',
                },
                attemptId: 'attempt-1',
                allowWhenActionsBlocked: true,
            });
        });

        it('should clear calibration success state if no longer ready', () => {
            deps.getCalibrationState = () => 'success';
            // Configure deps so resolveReadinessDecision naturally returns awaiting_stabilization (not ready):
            deps.sfe.resolveByConversation = mock(
                () => ({ ready: false, reason: 'captured_not_ready', blockingConditions: [] }) as any,
            );
            deps.evaluateReadinessForData = mock(
                () => ({ ready: false, terminal: false, reason: 'in_progress' }) as any,
            );
            refreshButtonState('123', deps, lastButtonStateLog);
            expect(deps.setCalibrationState).toHaveBeenCalledWith('idle');
            expect(deps.emitExternalConversationEvent).not.toHaveBeenCalled();
        });

        it('should extract canonical sample if fully completed', () => {
            refreshButtonState('123', deps, lastButtonStateLog);
            expect(deps.ingestSfeCanonicalSample).toHaveBeenCalledWith({ conversation_id: '123' }, 'attempt-1');
        });
    });

    describe('scheduleButtonRefresh', () => {
        it('should set an immediate timeout', () => {
            scheduleButtonRefresh('123', deps, lastButtonStateLog);
            expect(globalThis.setTimeout).toHaveBeenCalled();
        });

        it('should execute tick successfully if canonical ready and call refreshButtonState', () => {
            let callback: (() => void) | undefined;
            globalThis.setTimeout = mock((fn) => {
                callback = fn as () => void;
                return 123 as any;
            }) as any;

            scheduleButtonRefresh('123', deps, lastButtonStateLog);
            expect(callback).toBeDefined();

            callback!();

            expect(deps.buttonManager.setReadinessSource).toHaveBeenCalled(); // via refreshButtonState
        });

        it('should retry if button does not exist yet', () => {
            let callback: (() => void) | undefined;
            globalThis.setTimeout = mock((fn) => {
                callback = fn as () => void;
                return 123 as any;
            }) as any;

            scheduleButtonRefresh('123', deps, lastButtonStateLog);
            deps.buttonManager.exists = () => false;

            callback!();

            expect(deps.buttonManager.setSaveButtonMode).not.toHaveBeenCalled();
        });
    });

    describe('injectSaveButton', () => {
        it('should exit if button target is missing', () => {
            mockAdapter.getButtonInjectionTarget = () => null as any;
            injectSaveButton(deps, lastButtonStateLog);
            expect(deps.buttonManager.inject).not.toHaveBeenCalled();
            expect(logCalls.info).toHaveLength(1);
            expect(logCalls.info[0].message).toContain('target missing');
        });

        it('should handle no conversation ID correctly', () => {
            mockAdapter.extractConversationId = () => null;
            injectSaveButton(deps, lastButtonStateLog);
            expect(deps.buttonManager.inject).toHaveBeenCalled();
            expect(deps.setCurrentConversation).toHaveBeenCalledWith(null);
            expect(deps.buttonManager.setActionButtonsEnabled).toHaveBeenCalledWith(false);
            expect(logCalls.info).toHaveLength(1);
        });

        it('should handle injection successfully if conversation present', () => {
            let _timeoutCallback: (() => void) | undefined;
            globalThis.setTimeout = ((fn: () => void) => {
                _timeoutCallback = fn;
            }) as any;

            injectSaveButton(deps, lastButtonStateLog);
            expect(deps.buttonManager.inject).toHaveBeenCalled();
            expect(deps.buttonManager.setActionButtonsEnabled).toHaveBeenCalledWith(true);
            expect(deps.setCurrentConversation).toHaveBeenCalledWith('123');
            expect(deps.buttonManager.setReadinessSource).toHaveBeenCalled(); // part of refresh
        });
    });
});
