import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { LLMPlatform } from '@/platforms/types';
import { buildLoggerMock, createLoggerCalls } from '@/utils/runner/__tests__/helpers';
import {
    type CalibrationCaptureDeps,
    captureFromRetries,
    captureFromSnapshot,
    isConversationDataLike,
    isRawCaptureSnapshot,
    type RawCaptureSnapshot,
    runCalibrationStep,
    waitForDomQuietPeriod,
    waitForPassiveCapture,
} from '@/utils/runner/calibration-capture';
import type { ConversationData } from '@/utils/types';

const logCalls = createLoggerCalls();
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));

describe('calibration-capture', () => {
    let deps: CalibrationCaptureDeps;
    let mockAdapter: LLMPlatform;
    let originalSetTimeout: typeof setTimeout;
    let originalSetInterval: typeof setInterval;
    let originalClearInterval: typeof clearInterval;

    beforeEach(() => {
        logCalls.debug.length = 0;
        logCalls.info.length = 0;
        logCalls.warn.length = 0;
        logCalls.error.length = 0;

        (globalThis as any).window = globalThis;

        mockAdapter = {
            name: 'ChatGPT',
        } as unknown as LLMPlatform;

        deps = {
            adapter: mockAdapter,
            isCaptureSatisfied: mock(() => false),
            flushQueuedMessages: mock(() => {}),
            requestSnapshot: mock(() => Promise.resolve(null)),
            buildIsolatedSnapshot: mock(() => null),
            ingestConversationData: mock(() => {}),
            ingestInterceptedData: mock(() => {}),
            getFetchUrlCandidates: mock(() => []),
            getRawSnapshotReplayUrls: mock(() => []),
        };

        originalSetTimeout = globalThis.setTimeout;
        originalSetInterval = globalThis.setInterval;
        originalClearInterval = globalThis.clearInterval;
    });

    afterEach(() => {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
    });

    describe('type guards', () => {
        it('isRawCaptureSnapshot should correctly identify snapshots', () => {
            expect(
                isRawCaptureSnapshot({ __blackiyaSnapshotType: 'raw-capture', data: 'data', url: 'url' }),
            ).toBeTrue();
            expect(isRawCaptureSnapshot({ __blackiyaSnapshotType: 'raw-capture' })).toBeFalse();
            expect(isRawCaptureSnapshot(null)).toBeFalse();
        });

        it('isConversationDataLike should correctly identify conversation data', () => {
            expect(isConversationDataLike({ conversation_id: '123', mapping: {} })).toBeTrue();
            expect(isConversationDataLike({ conversation_id: '123' })).toBeFalse();
            expect(isConversationDataLike(null)).toBeFalse();
        });
    });

    describe('waitForPassiveCapture', () => {
        it('should return true if satisfied quickly', async () => {
            deps.isCaptureSatisfied = mock(() => true);
            const result = await waitForPassiveCapture('123', 'auto', deps);
            expect(result).toBeTrue();
            expect(deps.flushQueuedMessages).toHaveBeenCalled();
        });

        it('should loop and timeout if never satisfied', async () => {
            // Mock Date.now and setTimeout to simulate time passing instantly
            let currentTime = 1000;
            const originalDateNow = Date.now;
            globalThis.Date.now = () => currentTime;

            globalThis.setTimeout = mock((fn) => {
                currentTime += 300; // Increment past 250ms interval
                (fn as Function)();
                return 1 as any; // Mock timer ID
            }) as any;

            deps.isCaptureSatisfied = mock(() => false);
            const result = await waitForPassiveCapture('123', 'auto', deps);

            globalThis.Date.now = originalDateNow;

            expect(result).toBeFalse();
            expect(deps.flushQueuedMessages).toHaveBeenCalled();
        });
    });

    describe('waitForDomQuietPeriod', () => {
        let originalMutationObserver: typeof MutationObserver;
        let originalDocument: Document;

        beforeEach(() => {
            originalMutationObserver = globalThis.MutationObserver;
            originalDocument = globalThis.document;

            (globalThis.MutationObserver as any) = class {
                observe() {}
                disconnect() {}
            };

            (globalThis.document as any) = {
                querySelector: mock(() => ({})),
                body: {},
            };
        });

        afterEach(() => {
            globalThis.MutationObserver = originalMutationObserver;
            globalThis.document = originalDocument;
        });

        it('should return true immediately if no element found', async () => {
            (globalThis.document as any).querySelector = mock(() => null);
            (globalThis.document as any).body = null;
            const result = await waitForDomQuietPeriod('123', 'ChatGPT', 500, 1000);
            expect(result).toBeTrue();
        });

        it('should wait for quiet period and return true', async () => {
            let currentTime = 1000;
            const originalDateNow = Date.now;
            globalThis.Date.now = () => currentTime;

            let intervalCallback: Function;
            globalThis.setInterval = mock((fn) => {
                intervalCallback = fn as Function;
                return 123 as any; // timer id
            }) as any;

            globalThis.clearInterval = mock(() => {}) as any;

            const promise = waitForDomQuietPeriod('123', 'ChatGPT', 500, 1000);

            // Time advances, but no mutation
            currentTime = 1600; // Passed 500ms since start
            if (intervalCallback!) {
                intervalCallback();
            }

            globalThis.Date.now = originalDateNow;

            const result = await promise;
            expect(result).toBeTrue();
            expect(globalThis.clearInterval).toHaveBeenCalledWith(123);
        });
    });

    describe('captureFromSnapshot', () => {
        let originalMutationObserver: typeof MutationObserver;
        let originalDocument: Document;

        beforeEach(() => {
            originalMutationObserver = globalThis.MutationObserver;
            originalDocument = globalThis.document;

            (globalThis.MutationObserver as any) = class {
                observe() {}
                disconnect() {}
            };

            (globalThis.document as any) = {
                querySelector: mock(() => ({})),
                body: {},
            };
        });

        afterEach(() => {
            globalThis.MutationObserver = originalMutationObserver;
            globalThis.document = originalDocument;
        });

        it('should return false if dom is not quiet (auto ChatGPT/Gemini)', async () => {
            let currentTime = 1000;
            const originalDateNow = Date.now;
            globalThis.Date.now = () => currentTime;

            let intervalCallback: Function;
            globalThis.setInterval = mock((fn) => {
                intervalCallback = fn as Function;
                return 123 as any;
            }) as any;

            let observerCallback: Function;
            (globalThis.MutationObserver as any) = class {
                constructor(cb: Function) {
                    observerCallback = cb;
                }
                observe() {}
                disconnect() {}
            };
            globalThis.clearInterval = mock(() => {}) as any;

            deps.adapter.name = 'ChatGPT';
            const promise = captureFromSnapshot('123', 'auto', deps);

            currentTime = 21000; // Advance past 20000ms timeout
            if (observerCallback!) {
                observerCallback(); // Last mutation at 21000
            }
            currentTime = 22000; // 22000 - 21000 = 1000 (< 1400 quiet). 22000 - 1000 = 21000 (> 20000 timeout). Timeouts and fails.
            if (intervalCallback!) {
                intervalCallback();
            }

            globalThis.Date.now = originalDateNow;

            const result = await promise;
            expect(result).toBeFalse();
            expect(deps.requestSnapshot).not.toHaveBeenCalled();
        });

        it('should request snapshot and ingest conversation data', async () => {
            deps.adapter.name = 'Grok'; // Skip DOM quiet wait
            const fakeData = { conversation_id: '123', mapping: {} };
            deps.requestSnapshot = mock(() => Promise.resolve(fakeData));
            deps.isCaptureSatisfied = mock(() => true);

            const result = await captureFromSnapshot('123', 'manual', deps);

            expect(result).toBeTrue();
            expect(deps.ingestConversationData).toHaveBeenCalledWith(fakeData, 'calibration-snapshot');
        });

        it('should ingest raw snapshot and try replay urls', async () => {
            deps.adapter.name = 'Grok';
            const fakeSnapshot: RawCaptureSnapshot = {
                __blackiyaSnapshotType: 'raw-capture',
                data: 'some data',
                url: 'some url',
            };
            deps.requestSnapshot = mock(() => Promise.resolve(fakeSnapshot));
            deps.getRawSnapshotReplayUrls = mock(() => ['url1', 'url2']);
            deps.isCaptureSatisfied = mock(() => true);

            const result = await captureFromSnapshot('123', 'manual', deps);

            expect(result).toBeTrue();
            expect(deps.ingestInterceptedData).toHaveBeenCalledWith({
                url: 'url1',
                data: 'some data',
                platform: 'Grok',
            });
        });

        it('should fallback to isolated snapshot if raw replay fails', async () => {
            deps.adapter.name = 'Grok';
            const fakeSnapshot: RawCaptureSnapshot = {
                __blackiyaSnapshotType: 'raw-capture',
                data: 'some data',
                url: 'some url',
            };
            deps.requestSnapshot = mock(() => Promise.resolve(fakeSnapshot));
            deps.getRawSnapshotReplayUrls = mock(() => ['url1']);
            deps.isCaptureSatisfied = mock(() => false); // Still not satisfied after replay

            const isolatedFallback = { conversation_id: '123', mapping: {} } as unknown as ConversationData;
            deps.buildIsolatedSnapshot = mock(() => isolatedFallback);

            const result = await captureFromSnapshot('123', 'manual', deps);

            expect(result).toBeFalse();
            expect(deps.ingestConversationData).toHaveBeenCalledWith(
                isolatedFallback,
                'calibration-isolated-dom-fallback',
            );
        });

        it('should ingest regular snapshot via ingestInterceptedData', async () => {
            deps.adapter.name = 'Grok';
            deps.requestSnapshot = mock(() => Promise.resolve({ foo: 'bar' })); // Not conversation data, not raw snapshot
            deps.isCaptureSatisfied = mock(() => true);

            const result = await captureFromSnapshot('123', 'manual', deps);

            expect(result).toBeTrue();
            expect(deps.ingestInterceptedData).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: 'page-snapshot://Grok/123',
                    data: JSON.stringify({ foo: 'bar' }),
                }),
            );
        });
    });

    describe('captureFromRetries', () => {
        let originalFetch: typeof fetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        it('should exit immediately if no candidates', async () => {
            const result = await captureFromRetries('123', 'auto', deps);
            expect(result).toBeFalse();
        });

        it('should try fetching and ingest result', async () => {
            deps.getFetchUrlCandidates = mock(() => ['url1']);
            deps.isCaptureSatisfied = mock(() => true);

            globalThis.fetch = mock(() =>
                Promise.resolve({
                    ok: true,
                    status: 200,
                    text: () => Promise.resolve('fetch data'),
                }),
            ) as any;

            const result = await captureFromRetries('123', 'auto', deps);

            expect(result).toBeTrue();
            expect(deps.ingestInterceptedData).toHaveBeenCalledWith({
                url: 'url1',
                data: 'fetch data',
                platform: 'ChatGPT',
            });
        });

        it('should handle fetch errors safely', async () => {
            deps.getFetchUrlCandidates = mock(() => ['url1']);

            globalThis.fetch = mock(() => Promise.reject(new Error('Network error'))) as any;

            // Use instant backoff mapping by mocking setTimeout
            globalThis.setTimeout = mock((fn) => {
                (fn as Function)();
                return 1 as any;
            }) as any;

            const result = await captureFromRetries('123', 'auto', deps);

            expect(result).toBeFalse();
            expect(logCalls.error).toHaveLength(6); // One for each backoff try
        });

        it('should handle fetch aborts properly', async () => {
            deps.getFetchUrlCandidates = mock(() => ['url1']);
            deps.isCaptureSatisfied = mock(() => false);

            const abortError = new Error('AbortError');
            abortError.name = 'AbortError';

            globalThis.fetch = mock(() => Promise.reject(abortError)) as any;
            globalThis.setTimeout = mock((fn) => {
                (fn as Function)();
                return 1 as any;
            }) as any;

            await captureFromRetries('123', 'auto', deps);

            expect(logCalls.error).toHaveLength(6);
            expect(logCalls.error[0].message).toContain('Calibration fetch timeout');
        });
    });

    describe('runCalibrationStep', () => {
        it('should route to correct step handler', async () => {
            deps.isCaptureSatisfied = mock(() => true);

            let result = await runCalibrationStep('queue-flush', '123', 'auto', deps);
            expect(deps.flushQueuedMessages).toHaveBeenCalled();
            expect(result).toBeTrue();

            result = await runCalibrationStep('unknown' as any, '123', 'auto', deps);
            expect(result).toBeFalse();
        });
    });
});
