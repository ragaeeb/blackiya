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

mock.module('@/utils/runner/readiness', () => ({
    resolveRunnerReadinessDecision: mock((args) => {
        // Mock default behavior
        return { mode: 'canonical_ready', ready: true, terminal: true, reason: 'terminal' };
    }),
}));

import { resolveRunnerReadinessDecision } from '@/utils/runner/readiness';

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
        globalThis.setTimeout = mock((fn) => {
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
                resolveByConversation: mock(() => ({ ready: true, reason: 'term', blockingConditions: [] })),
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
            emitPublicStatusSnapshot: mock(() => {}),

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

        // Reset the mock module behavior
        (resolveRunnerReadinessDecision as ReturnType<typeof mock>).mockClear();
        (resolveRunnerReadinessDecision as ReturnType<typeof mock>).mockImplementation(() => {
            return { mode: 'canonical_ready', ready: true, terminal: true, reason: 'terminal' };
        });
    });

    afterEach(() => {
        globalThis.setTimeout = originalSetTimeout;
        delete (globalThis as any).window;
    });

    describe('resolveReadinessDecision', () => {
        it('should call resolveRunnerReadinessDecision with proper arguments', () => {
            // Need to verify standard call properties passed
            resolveReadinessDecision('123', deps);
            expect(resolveRunnerReadinessDecision).toHaveBeenCalled();
            const args = (resolveRunnerReadinessDecision as ReturnType<typeof mock>).mock.calls[0][0];
            expect(args.conversationId).toBe('123');
            expect(args.sfeEnabled).toBeTrue();
        });

        it('should emit timeout warning only once per attempt', () => {
            resolveReadinessDecision('123', deps);
            const args = (resolveRunnerReadinessDecision as ReturnType<typeof mock>).mock.calls[0][0];
            args.emitTimeoutWarningOnce('attempt-1', '123');
            expect(deps.structuredLogger.emit).toHaveBeenCalledTimes(1);

            // Call again
            args.emitTimeoutWarningOnce('attempt-1', '123');
            expect(deps.structuredLogger.emit).toHaveBeenCalledTimes(1);
        });

        it('should throttle canonical ready log decisions over TTL', () => {
            resolveReadinessDecision('123', deps);
            const args = (resolveRunnerReadinessDecision as ReturnType<typeof mock>).mock.calls[0][0];
            expect(args.shouldLogCanonicalReadyDecision('123')).toBeTrue();
            expect(args.shouldLogCanonicalReadyDecision('123')).toBeFalse();
        });

        it('should properly clear timeout warnings and canonical ready log stamps', () => {
            resolveReadinessDecision('123', deps);
            const args = (resolveRunnerReadinessDecision as ReturnType<typeof mock>).mock.calls[0][0];

            deps.timeoutWarningByAttempt.add('attempt-1');
            args.clearTimeoutWarningByAttempt('attempt-1');
            expect(deps.timeoutWarningByAttempt.has('attempt-1')).toBeFalse();

            deps.lastCanonicalReadyLogAtByConversation.set('123', Date.now());
            args.clearCanonicalReadyLogStamp('123');
            expect(deps.lastCanonicalReadyLogAtByConversation.has('123')).toBeFalse();
        });
    });

    describe('isConversationReadyForActions', () => {
        it('should return true if mode is canonical_ready', () => {
            expect(isConversationReadyForActions('123', {}, deps)).toBeTrue();
        });

        it('should return false if mode is degraded and includeDegraded is false or omitted', () => {
            (resolveRunnerReadinessDecision as ReturnType<typeof mock>).mockImplementation(() => {
                return { mode: 'degraded_manual_only', ready: false, terminal: false, reason: 'degraded' };
            });
            expect(isConversationReadyForActions('123', {}, deps)).toBeFalse();
        });

        it('should return true if mode is degraded and includeDegraded is true', () => {
            (resolveRunnerReadinessDecision as ReturnType<typeof mock>).mockImplementation(() => {
                return { mode: 'degraded_manual_only', ready: false, terminal: false, reason: 'degraded' };
            });
            expect(isConversationReadyForActions('123', { includeDegraded: true }, deps)).toBeTrue();
        });

        it('should return false if mode is not_ready', () => {
            (resolveRunnerReadinessDecision as ReturnType<typeof mock>).mockImplementation(() => {
                return { mode: 'not_ready', ready: false, terminal: false, reason: 'in_progress' };
            });
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
            expect(deps.emitPublicStatusSnapshot).toHaveBeenCalledWith(null);
            expect(deps.buttonManager.setSaveButtonMode).not.toHaveBeenCalled();
        });

        it('should exit and snapshot if button does not exist', () => {
            deps.buttonManager.exists = () => false;
            refreshButtonState('123', deps, lastButtonStateLog);
            expect(deps.emitPublicStatusSnapshot).toHaveBeenCalledWith('123');
            expect(deps.buttonManager.setSaveButtonMode).not.toHaveBeenCalled();
        });

        it('should clear UI if no conversation is found in URL and no arg provided', () => {
            mockAdapter.extractConversationId = () => null;
            refreshButtonState(undefined, deps, lastButtonStateLog);
            expect(deps.emitPublicStatusSnapshot).toHaveBeenCalledWith(null);
            expect(deps.setCurrentConversation).toHaveBeenCalledWith(null);
            expect(deps.buttonManager.setActionButtonsEnabled).toHaveBeenCalledWith(false);
        });

        it('should disable buttons if actively generating', () => {
            deps.getLifecycleState = () => 'streaming';
            refreshButtonState('123', deps, lastButtonStateLog);
            expect(deps.buttonManager.setActionButtonsEnabled).toHaveBeenCalledWith(false);
            expect(deps.buttonManager.setOpacity).toHaveBeenCalledWith('0.6');
            expect(deps.emitPublicStatusSnapshot).toHaveBeenCalledWith('123');
        });

        it('should enable save button in degraded mode', () => {
            (resolveRunnerReadinessDecision as ReturnType<typeof mock>).mockImplementation(() => {
                return { mode: 'degraded_manual_only', ready: false };
            });
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
        });

        it('should clear calibration success state if no longer ready', () => {
            deps.getCalibrationState = () => 'success';
            (resolveRunnerReadinessDecision as ReturnType<typeof mock>).mockImplementation(() => {
                return { mode: 'not_ready', ready: false };
            });
            refreshButtonState('123', deps, lastButtonStateLog);
            expect(deps.setCalibrationState).toHaveBeenCalledWith('idle');
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
            let callback: Function | undefined;
            globalThis.setTimeout = mock((fn) => {
                callback = fn as Function;
                return 123 as any;
            }) as any;

            scheduleButtonRefresh('123', deps, lastButtonStateLog);
            expect(callback).toBeDefined();

            callback!();

            expect(deps.buttonManager.setReadinessSource).toHaveBeenCalled(); // via refreshButtonState
        });

        it('should retry if button does not exist yet', () => {
            let callback: Function | undefined;
            globalThis.setTimeout = mock((fn) => {
                callback = fn as Function;
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
            let timeoutCallback: Function | undefined;
            globalThis.setTimeout = ((fn: Function) => {
                timeoutCallback = fn;
            }) as any;

            injectSaveButton(deps, lastButtonStateLog);
            expect(deps.buttonManager.inject).toHaveBeenCalled();
            expect(deps.buttonManager.setActionButtonsEnabled).toHaveBeenCalledWith(true);
            expect(deps.setCurrentConversation).toHaveBeenCalledWith('123');
            expect(deps.buttonManager.setReadinessSource).toHaveBeenCalled(); // part of refresh
        });
    });
});
