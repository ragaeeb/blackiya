import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { buildLoggerMock, createLoggerCalls } from '@/utils/runner/__tests__/helpers';
import {
    executeWarmFetchCandidates,
    tryWarmFetchCandidate,
    warmFetchConversationSnapshot,
} from '@/utils/runner/warm-fetch';

const logCalls = createLoggerCalls();
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));

describe('warm-fetch', () => {
    let deps: any;
    let originalWindow: any;
    let originalSetTimeout: any;
    let originalClearTimeout: any;

    beforeEach(() => {
        logCalls.debug.length = 0;
        logCalls.info.length = 0;
        logCalls.warn.length = 0;
        logCalls.error.length = 0;

        originalWindow = (globalThis as any).window;
        originalSetTimeout = originalWindow?.setTimeout;
        originalClearTimeout = globalThis.clearTimeout;

        deps = {
            platformName: 'ChatGPT',
            getFetchUrlCandidates: mock(() => ['url-1', 'url-2']),
            ingestInterceptedData: mock(() => {}),
            getConversation: mock(() => null),
            evaluateReadiness: mock(() => ({ ready: true }) as any),
            getCaptureMeta: mock(() => ({}) as any),
        };

        // Install an isolated window stub so readonly browser-like descriptors
        // from other suites cannot break location/origin assignment.
        (globalThis as any).window = {
            location: { origin: 'http://localhost', href: 'http://localhost/' },
        };
        (globalThis as any).window.setTimeout = mock(() => 123) as any;
        globalThis.clearTimeout = mock(() => {}) as any;

        // Mock fetch
        globalThis.fetch = mock(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                text: () => Promise.resolve('{"data": "mock"}'),
            }),
        ) as any;
    });

    afterEach(() => {
        delete (globalThis as any).fetch;
        if (originalWindow) {
            (globalThis as any).window = originalWindow;
            if (typeof originalSetTimeout !== 'undefined') {
                (globalThis as any).window.setTimeout = originalSetTimeout;
            }
        } else {
            delete (globalThis as any).window;
        }
        globalThis.clearTimeout = originalClearTimeout;
    });

    describe('tryWarmFetchCandidate', () => {
        it('should resolve true if fetch successful and cached', async () => {
            deps.getConversation.mockImplementationOnce(() => ({ data: 'mock' }));
            const result = await tryWarmFetchCandidate('c-1', 'initial-load', 'http://test', deps);

            expect(result.success).toBeTrue();
            expect(result.notFound).toBeFalse();
            expect(deps.ingestInterceptedData).toHaveBeenCalledWith({
                url: 'http://test',
                data: '{"data": "mock"}',
                platform: 'ChatGPT',
            });
        });

        it('should return false if fetch succeeds but caching fails', async () => {
            const result = await tryWarmFetchCandidate('c-1', 'initial-load', 'http://test', deps);
            expect(result.success).toBeFalse();
            expect(result.notFound).toBeFalse();
        });

        it('should return false if fetch fails', async () => {
            globalThis.fetch = mock(() => Promise.resolve({ ok: false, status: 500 })) as any;
            const result = await tryWarmFetchCandidate('c-1', 'initial-load', 'http://test', deps);
            expect(result.success).toBeFalse();
            expect(result.notFound).toBeFalse();
        });

        it('should flag notFound on 404', async () => {
            globalThis.fetch = mock(() => Promise.resolve({ ok: false, status: 404 })) as any;
            const result = await tryWarmFetchCandidate('c-1', 'initial-load', 'http://test', deps);
            expect(result.success).toBeFalse();
            expect(result.notFound).toBeTrue();
        });

        it('should return false on network error', async () => {
            globalThis.fetch = mock(() => Promise.reject(new Error('Network error'))) as any;
            const result = await tryWarmFetchCandidate('c-1', 'initial-load', 'http://test', deps);
            expect(result.success).toBeFalse();
            expect(result.notFound).toBeFalse();
            expect(logCalls.debug.length).toBeGreaterThan(0);
        });
    });

    describe('executeWarmFetchCandidates', () => {
        it('should return true if first candidate succeeds', async () => {
            deps.getConversation.mockImplementationOnce(() => ({ data: '1' }));
            const result = await executeWarmFetchCandidates('c-1', 'initial-load', deps);
            expect(result).toBeTrue();
            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        });

        it('should fallback and return true if second succeeds', async () => {
            (globalThis.fetch as any).mockImplementationOnce(() => Promise.resolve({ ok: false })); // fail first
            deps.getConversation.mockImplementation(() => ({ data: 'cached' })); // succeed next

            const result = await executeWarmFetchCandidates('c-1', 'initial-load', deps);
            expect(result).toBeTrue();
            expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        });

        it('should return false if all fail or no candidates', async () => {
            deps.getFetchUrlCandidates = () => [];
            let result = await executeWarmFetchCandidates('c-1', 'initial-load', deps);
            expect(result).toBeFalse();

            deps.getFetchUrlCandidates = () => ['url-1'];
            result = await executeWarmFetchCandidates('c-1', 'initial-load', deps); // mock returns ok=true, but getConversation returns null
            expect(result).toBeFalse();
        });

        it('should include tried candidate paths in all-failed diagnostics', async () => {
            deps.getFetchUrlCandidates = () => ['url-1', 'url-2', 'url-3'];
            // Use 500 (not 404) so it tries all candidates before logging 'all failed'
            globalThis.fetch = mock(() => Promise.resolve({ ok: false, status: 500 })) as any;

            const result = await executeWarmFetchCandidates('c-1', 'stabilization-retry', deps);
            expect(result).toBeFalse();

            const failureLog = logCalls.debug.find((entry) => entry.message === 'Warm fetch all candidates failed');
            expect(failureLog).toBeDefined();
            expect(failureLog?.args[0]).toMatchObject({
                conversationId: 'c-1',
                reason: 'stabilization-retry',
                candidateCount: 3,
                triedPaths: ['/url-1', '/url-2'],
            });
            expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        });

        it('should abort only after ALL candidates return 404', async () => {
            deps.getFetchUrlCandidates = () => ['url-1', 'url-2'];
            globalThis.fetch = mock(() => Promise.resolve({ ok: false, status: 404 })) as any;

            const result = await executeWarmFetchCandidates('c-1', 'stabilization-retry', deps);
            expect(result).toBeFalse();
            // Should try BOTH candidates — 404 on one doesn't mean the other will 404
            expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        });

        it('should still try second candidate on non-404 errors (e.g. 500)', async () => {
            deps.getFetchUrlCandidates = () => ['url-1', 'url-2'];
            globalThis.fetch = mock(() => Promise.resolve({ ok: false, status: 500 })) as any;

            const result = await executeWarmFetchCandidates('c-1', 'stabilization-retry', deps);
            expect(result).toBeFalse();
            // Should try both candidates for transient errors
            expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        });
    });

    describe('warmFetchConversationSnapshot', () => {
        it('should skip if cached is already ready+canonical', async () => {
            deps.getConversation.mockImplementationOnce(() => ({ data: 'cached' }));
            deps.evaluateReadiness.mockImplementationOnce(() => ({ ready: true, terminal: true }));
            deps.getCaptureMeta.mockImplementationOnce(() => ({ captureSource: 'canonical_api' }));

            const inFlight = new Map();
            const result = await warmFetchConversationSnapshot('c-1', 'force-save', deps, inFlight);

            expect(result).toBeTrue();
            expect(globalThis.fetch).not.toHaveBeenCalled();
            expect(inFlight.size).toBe(0);
        });

        it('should dedup inFlight requests', async () => {
            const inFlight = new Map([['ChatGPT:c-1', Promise.resolve(true)]]);
            const result = await warmFetchConversationSnapshot('c-1', 'force-save', deps, inFlight);
            expect(result).toBeTrue();
            expect(globalThis.fetch).not.toHaveBeenCalled();
        });

        it('should execute candidates and set/clear inFlight', async () => {
            const inFlight = new Map();
            let mockCalled = false;
            deps.getConversation.mockImplementation(() => {
                const res = mockCalled ? { data: 'cached' } : null;
                mockCalled = true;
                return res;
            });
            const p = warmFetchConversationSnapshot('c-1', 'initial-load', deps, inFlight);
            expect(inFlight.has('ChatGPT:c-1')).toBeTrue();

            const result = await p;
            expect(result).toBeTrue();
            expect(inFlight.has('ChatGPT:c-1')).toBeFalse();
        });
    });
});
