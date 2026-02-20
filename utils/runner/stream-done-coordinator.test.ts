import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createStreamDoneCoordinator, type StreamDoneCoordinatorDeps } from '@/utils/runner/stream-done-coordinator';

describe('stream-done-coordinator', () => {
    let deps: StreamDoneCoordinatorDeps;

    let originalSetTimeout: any;
    let originalClearTimeout: any;

    beforeEach(() => {
        originalSetTimeout = (globalThis as any).window?.setTimeout;
        originalClearTimeout = globalThis.clearTimeout;
        
        deps = {
            runStreamDoneProbeCore: mock((_cid: string, _aid: string | undefined, _deps: any) => Promise.resolve()),
            probeLease: {
                claim: mock(() => Promise.resolve({ acquired: true, ownerAttemptId: null, expiresAtMs: 0 })),
                release: mock(() => Promise.resolve()),
            } as any,
            probeLeaseTtlMs: 5000,
            probeLeaseRetryGraceMs: 1000,
            streamProbeControllers: new Map(),
            probeLeaseRetryTimers: new Map(),
            attemptByConversation: new Map(),
            resolveAliasedAttemptId: mock((id) => id),
            isAttemptDisposedOrSuperseded: mock(() => false),
            structuredLogger: { emit: mock(() => {}) } as any,
            setStreamProbePanel: mock(() => {}),
            withPreservedLiveMirrorSnapshot: mock((_c, _s, b) => b),
            resolveAttemptId: mock(() => 'a-1'),
            getCurrentAdapter: mock(() => ({ name: 'ChatGPT', parseInterceptedData: () => ({}) }) as any),
            getFetchUrlCandidates: mock(() => []),
            getRawSnapshotReplayUrls: mock(() => []),
            getConversation: mock(() => null),
            evaluateReadiness: mock(() => ({ ready: true }) as any),
            ingestConversationData: mock(() => {}),
            ingestInterceptedData: mock(() => {}),
            requestSnapshot: mock(() => Promise.resolve(null)),
            buildIsolatedSnapshot: mock(() => null),
            extractResponseText: mock(() => 'txt'),
            setLastProbeKey: mock(() => {}),
            isProbeKeyActive: mock(() => true),
        };

        if (!(globalThis as any).window) {
            (globalThis as any).window = {};
        }
        (globalThis as any).window.setTimeout = mock((fn, ms) => {
            const _timers = deps.probeLeaseRetryTimers;
            // Immediate invoke for ease of testing
            if (ms <= 1000) {
                fn();
            }
            return 123;
        }) as any;
        globalThis.clearTimeout = mock(() => {}) as any;
    });

    afterEach(() => {
        if ((globalThis as any).window) {
            (globalThis as any).window.setTimeout = originalSetTimeout;
        }
        globalThis.clearTimeout = originalClearTimeout;
    });

    describe('createStreamDoneCoordinator', () => {
        let coordinator: ReturnType<typeof createStreamDoneCoordinator>;
        beforeEach(() => {
            coordinator = createStreamDoneCoordinator(deps);
        });

        it('cancelStreamDoneProbe should abort controller and structured log', () => {
            const abort = mock(() => {});
            deps.streamProbeControllers.set('a-1', { abort } as any);
            coordinator.cancelStreamDoneProbe('a-1', 'superseded');

            expect(abort).toHaveBeenCalled();
            expect(deps.streamProbeControllers.has('a-1')).toBeFalse();
            expect(deps.structuredLogger.emit).toHaveBeenCalledWith(
                'a-1',
                'debug',
                'probe_cancelled',
                expect.any(String),
                { reason: 'superseded' },
                expect.any(String),
            );
        });

        it('clearProbeLeaseRetry should clear timeouts and maps', () => {
            deps.probeLeaseRetryTimers.set('a-1', 456);
            coordinator.clearProbeLeaseRetry('a-1');

            expect(globalThis.clearTimeout).toHaveBeenCalledWith(456);
            expect(deps.probeLeaseRetryTimers.has('a-1')).toBeFalse();
        });

        it('runStreamDoneProbe should construct probe deps and invoke core', async () => {
            await coordinator.runStreamDoneProbe('c-1', 'a-1');
        });

        it('should handle unacquired probe leases by establishing retry timer sequence', async () => {
            let builtAcquire: any;
            deps.runStreamDoneProbeCore = mock((_c: string, _a: string | undefined, p: any) => {
                builtAcquire = p.acquireProbeLease;
                return Promise.resolve();
            });

            coordinator = createStreamDoneCoordinator(deps);
            await coordinator.runStreamDoneProbe('c-1', 'a-1');

            deps.probeLease.claim = mock(() =>
                Promise.resolve({ acquired: false, ownerAttemptId: 'other', expiresAtMs: Date.now() + 50 }),
            );

            await builtAcquire('c-1', 'a-1'); // triggers timeout sequence
            expect(deps.setStreamProbePanel).toHaveBeenCalledWith(
                'stream-done: lease held by another tab',
                'Another tab is probing canonical capture for c-1. Retrying shortly.',
            );
            expect(deps.structuredLogger.emit).toHaveBeenCalledWith(
                'a-1',
                'debug',
                'probe_lease_blocked',
                expect.any(String),
                expect.any(Object),
                expect.any(String),
            );
        });
    });
});
