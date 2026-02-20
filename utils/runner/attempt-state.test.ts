import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
    bindAttempt,
    cachePendingLifecycleSignal,
    forwardAttemptAlias,
    resolveAliasedAttemptId,
} from '@/utils/runner/attempt-state';

describe('attempt-state', () => {
    describe('cachePendingLifecycleSignal', () => {
        let deps: any;
        beforeEach(() => {
            deps = {
                pendingLifecycleByAttempt: new Map(),
                maxPendingLifecycleAttempts: 5,
                warnIntervalMs: 15000,
                lastPendingLifecycleCapacityWarnAtRef: { value: 0 },
                emitWarn: mock(() => {}),
            };
        });

        it('should cache phase and not emit warn if below threshold', () => {
            cachePendingLifecycleSignal('a-1', 'streaming', 'platform', deps);
            expect(deps.pendingLifecycleByAttempt.has('a-1')).toBeTrue();
            expect(deps.emitWarn).not.toHaveBeenCalled();
        });

        it('should skip if existing phase has higher priority', () => {
            deps.pendingLifecycleByAttempt.set('a-1', { phase: 'completed', platform: 'platform', receivedAtMs: 0 });
            cachePendingLifecycleSignal('a-1', 'streaming', 'platform', deps);
            expect(deps.pendingLifecycleByAttempt.get('a-1').phase).toBe('completed');
        });

        it('should overwrite if existing phase has lower priority', () => {
            deps.pendingLifecycleByAttempt.set('a-1', { phase: 'prompt-sent', platform: 'platform', receivedAtMs: 0 });
            cachePendingLifecycleSignal('a-1', 'streaming', 'platform', deps);
            expect(deps.pendingLifecycleByAttempt.get('a-1').phase).toBe('streaming');
        });

        it('should emit warn if near capacity', () => {
            for (let i = 0; i < 4; i++) {
                deps.pendingLifecycleByAttempt.set(`a-${i}`, { phase: 'completed' });
            }

            cachePendingLifecycleSignal('a-new', 'streaming', 'platform', deps);
            expect(deps.emitWarn).toHaveBeenCalled();
        });
    });

    describe('resolveAliasedAttemptId', () => {
        it('should resolve through links without cycles', () => {
            const map = new Map([
                ['1', '2'],
                ['2', '3'],
            ]);
            expect(resolveAliasedAttemptId('1', map)).toBe('3');

            const cycleMap = new Map([
                ['1', '2'],
                ['2', '3'],
                ['3', '1'],
            ]);
            expect(resolveAliasedAttemptId('1', cycleMap)).toBe('1');
        });

        it('should return self if not aliased', () => {
            expect(resolveAliasedAttemptId('1', new Map())).toBe('1');
        });
    });

    describe('forwardAttemptAlias', () => {
        it('should set map and log if not self referential', () => {
            const deps = {
                attemptAliasForward: new Map(),
                maxAliasEntries: 10,
                structuredLogger: { emit: mock(() => {}) } as any,
            };
            forwardAttemptAlias('1', '2', 'superseded', deps);

            expect(deps.attemptAliasForward.get('1')).toBe('2');
            expect(deps.structuredLogger.emit).toHaveBeenCalledWith(
                '2',
                'info',
                'attempt_alias_forwarded',
                expect.any(String),
                expect.any(Object),
                expect.any(String),
            );
        });

        it('should skip if self referential', () => {
            const deps = {
                attemptAliasForward: new Map(),
                maxAliasEntries: 10,
                structuredLogger: { emit: mock(() => {}) } as any,
            };
            forwardAttemptAlias('1', '1', 'superseded', deps);
            expect(deps.attemptAliasForward.size).toBe(0);
        });
    });

    describe('bindAttempt', () => {
        let deps: any;
        beforeEach(() => {
            deps = {
                conversationId: 'c-1',
                attemptId: 'a-2',
                attemptByConversation: new Map([['c-1', 'a-1']]),
                resolveAliasedAttemptId: (x: string) => x,
                maxConversationAttempts: 10,
                markAttemptSuperseded: mock(() => {}),
                cancelStreamDoneProbe: mock(() => {}),
                clearCanonicalStabilizationRetry: mock(() => {}),
                clearProbeLeaseRetry: mock(() => {}),
                emitAttemptDisposed: mock(() => {}),
                forwardAttemptAlias: mock(() => {}),
                migratePendingStreamProbeText: mock(() => {}),
                structuredLogger: { emit: mock(() => {}) },
            };
        });

        it('should supersede previous attempt if different', () => {
            bindAttempt(deps);

            expect(deps.markAttemptSuperseded).toHaveBeenCalledWith('a-1', 'a-2');
            expect(deps.cancelStreamDoneProbe).toHaveBeenCalledWith('a-1', 'superseded');
            expect(deps.emitAttemptDisposed).toHaveBeenCalledWith('a-1', 'superseded');
            expect(deps.forwardAttemptAlias).toHaveBeenCalledWith('a-1', 'a-2', 'superseded');
            expect(deps.attemptByConversation.get('c-1')).toBe('a-2');
            expect(deps.migratePendingStreamProbeText).toHaveBeenCalledWith('c-1', 'a-2');
        });

        it('should not supersede if same attempt', () => {
            deps.attemptId = 'a-1';
            bindAttempt(deps);

            expect(deps.markAttemptSuperseded).not.toHaveBeenCalled();
            expect(deps.attemptByConversation.get('c-1')).toBe('a-1');
        });

        it('should skip if no conversation', () => {
            deps.conversationId = undefined;
            bindAttempt(deps);
            expect(deps.attemptByConversation.get('c-1')).toBe('a-1');
        });
    });
});
