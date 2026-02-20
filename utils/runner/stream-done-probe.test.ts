import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { runStreamDoneProbe, type StreamDoneProbeDeps } from '@/utils/runner/stream-done-probe';

describe('stream-done-probe', () => {
    let deps: StreamDoneProbeDeps;

    beforeEach(() => {
        deps = {
            platformName: 'ChatGPT',
            parseInterceptedData: mock(() => ({ conversation_id: 'conv-1' }) as any),
            isAttemptDisposedOrSuperseded: mock(() => false),
            acquireProbeLease: mock(() => Promise.resolve(true)),
            releaseProbeLease: mock(() => Promise.resolve()),
            cancelExistingProbe: mock(() => {}),
            registerProbeController: mock(() => {}),
            unregisterProbeController: mock(() => {}),
            resolveAttemptId: mock(() => 'attempt-1'),
            getFetchUrlCandidates: mock(() => ['url-1']),
            getRawSnapshotReplayUrls: mock(() => ['url-1']),
            getConversation: mock(() => null),
            evaluateReadiness: mock(() => ({ ready: true })),
            ingestConversationData: mock(() => {}),
            ingestInterceptedData: mock(() => {}),
            requestSnapshot: mock(() => Promise.resolve(null)),
            buildIsolatedSnapshot: mock(() => null),
            extractResponseText: mock(() => 'text'),
            setStreamDonePanel: mock(() => {}),
            onProbeActive: mock(() => {}),
            isProbeKeyActive: mock(() => true),
            emitLog: mock(() => {}),
        };
    });

    it('should bail if attempt disposed', async () => {
        deps.isAttemptDisposedOrSuperseded = mock(() => true);
        await runStreamDoneProbe('conv-1', 'attempt-1', deps);
        expect(deps.acquireProbeLease).not.toHaveBeenCalled();
    });

    it('should bail if lease not acquired', async () => {
        deps.acquireProbeLease = mock(() => Promise.resolve(false));
        await runStreamDoneProbe('conv-1', 'attempt-1', deps);
        expect(deps.getFetchUrlCandidates).not.toHaveBeenCalled();
    });

    it('should try fetching and successfully capture', async () => {
        const fetchMock = mock(() =>
            Promise.resolve({
                ok: true,
                text: () => Promise.resolve('resp'),
            }),
        ) as any;
        (globalThis as any).fetch = fetchMock;

        await runStreamDoneProbe('conv-1', 'attempt-1', deps);

        expect(deps.acquireProbeLease).toHaveBeenCalled();
        expect(deps.setStreamDonePanel).toHaveBeenCalledTimes(2); // Start + Fetch success
        expect(deps.emitLog).toHaveBeenCalledWith('info', 'Stream done probe start', expect.any(Object));
        expect(deps.emitLog).toHaveBeenCalledWith('info', 'Stream done probe success', expect.any(Object));

        delete (globalThis as any).fetch;
    });

    it('should fallback to snapshot if fetch fails', async () => {
        const fetchMock = mock(() => Promise.resolve({ ok: false })) as any;
        (globalThis as any).fetch = fetchMock;

        deps.requestSnapshot = mock(() => Promise.resolve({ mock: 'snapshot' }));
        let getConvCallCount = 0;
        deps.getConversation = mock(() => {
            getConvCallCount++;
            return getConvCallCount >= 2 ? ({ ready: true } as any) : null;
        });
        deps.evaluateReadiness = mock(() => ({ ready: true }));

        await runStreamDoneProbe('conv-1', 'attempt-1', deps);

        expect(deps.setStreamDonePanel).toHaveBeenCalledWith(
            'conv-1',
            'stream-done: degraded snapshot captured',
            expect.any(String),
        );
        expect(deps.ingestInterceptedData).toHaveBeenCalledWith(
            expect.objectContaining({
                data: '{"mock":"snapshot"}',
                platform: 'ChatGPT',
            }),
        );

        delete (globalThis as any).fetch;
    });

    it('should display awaiting panel if snapshot also fails', async () => {
        deps.getFetchUrlCandidates = mock(() => []); // simulate no candidates to hit fallback immediately

        await runStreamDoneProbe('conv-1', 'attempt-1', deps);

        // First handleNoCandidates triggers fallback, which fails because requestSnapshot returns null
        // And buildIsolatedSnapshot returns null.
        expect(deps.setStreamDonePanel).toHaveBeenCalledWith(
            'conv-1',
            'stream-done: no api url candidates',
            expect.any(String),
        );
    });

    it('should release lease unconditionally in finally block', async () => {
        const fetchMock = mock(() => Promise.reject(new Error('fail'))) as any;
        (globalThis as any).fetch = fetchMock;

        await runStreamDoneProbe('conv-1', 'attempt-1', deps);

        expect(deps.releaseProbeLease).toHaveBeenCalledWith('conv-1', 'attempt-1');
        expect(deps.unregisterProbeController).toHaveBeenCalledWith('attempt-1');

        delete (globalThis as any).fetch;
    });
});
