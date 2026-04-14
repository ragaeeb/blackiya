import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { ProactiveFetchRunner } from '@/entrypoints/interceptor/proactive-fetch-runner';
import type { LLMPlatform } from '@/platforms/types';

const createAdapter = (): LLMPlatform => ({
    name: 'TestPlatform',
    urlMatchPattern: 'https://example.com/*',
    apiEndpointPattern: /\/api\//i,
    completionTriggerPattern: /\/complete\//i,
    isPlatformUrl: () => true,
    extractConversationId: () => null,
    extractConversationIdFromUrl: (url: string) => url.match(/conv-[0-9]+/)?.[0] ?? null,
    buildApiUrl: (conversationId: string) => `/api/${conversationId}`,
    parseInterceptedData: (data: string) => {
        try {
            return JSON.parse(data);
        } catch {
            return null;
        }
    },
    formatFilename: () => 'test',
    getButtonInjectionTarget: () => null,
    evaluateReadiness: () => ({
        ready: true,
        terminal: true,
        reason: 'ready',
        contentHash: null,
        latestAssistantTextLength: 1,
    }),
});

const createEmitterDeps = () => ({
    isAttemptDisposed: mock(() => false),
    shouldLogTransient: mock(() => true),
    shouldEmitCapturedPayload: mock(() => true),
    log: mock(() => {}),
    emitCapturePayload: mock(() => {}),
});

type GlobalWithOptionalWindow = {
    window?: unknown;
};

type TestWindow = {
    setTimeout: typeof globalThis.setTimeout;
    location: {
        origin: string;
    };
};

describe('ProactiveFetchRunner', () => {
    let globalWithWindow: GlobalWithOptionalWindow;
    let hadWindow = false;
    let originalWindow: unknown;

    beforeEach(() => {
        globalWithWindow = globalThis as unknown as GlobalWithOptionalWindow;
        hadWindow = typeof globalWithWindow.window !== 'undefined';
        originalWindow = globalWithWindow.window;

        const immediateSetTimeout = ((
            callback: Parameters<typeof globalThis.setTimeout>[0],
            _timeout?: number,
            ...args: unknown[]
        ): ReturnType<typeof globalThis.setTimeout> => {
            if (typeof callback === 'function') {
                (callback as (...callbackArgs: unknown[]) => void)(...args);
            }
            return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
        }) as typeof globalThis.setTimeout;

        const testWindow: TestWindow = {
            setTimeout: immediateSetTimeout,
            location: { origin: 'https://example.com' },
        };
        globalWithWindow.window = testWindow;
    });

    afterEach(() => {
        if (hadWindow) {
            globalWithWindow.window = originalWindow;
            return;
        }
        delete globalWithWindow.window;
    });

    it('should fetch and emit capture payload when proactive fetch returns ready conversation data', async () => {
        const adapter = createAdapter();
        const emitter = createEmitterDeps();
        const originalFetch = mock(async () => new Response('{"conversation_id":"conv-1"}', { status: 200 }));
        const resolveAttemptIdForConversation = mock(() => 'attempt-1');
        const runner = new ProactiveFetchRunner(
            originalFetch as unknown as typeof fetch,
            resolveAttemptIdForConversation,
            emitter,
            100,
        );

        await runner.trigger(adapter, 'https://example.com/complete/conv-1');

        expect(originalFetch).toHaveBeenCalledTimes(1);
        expect(resolveAttemptIdForConversation).toHaveBeenCalledWith('conv-1', 'TestPlatform');
        expect(emitter.emitCapturePayload).toHaveBeenCalledTimes(1);
        const emitArgs = emitter.emitCapturePayload.mock.calls[0] as unknown as
            | [string, string, string, string]
            | undefined;
        expect(emitArgs?.[0]).toBe('/api/conv-1');
        expect(emitArgs?.[2]).toBe('TestPlatform');
        expect(emitArgs?.[3]).toBe('attempt-1');
    });

    it('should evaluate cooldown inside the in-flight lock before running fetch attempts', async () => {
        const adapter = createAdapter();
        const emitter = createEmitterDeps();
        const originalFetch = mock(async () => new Response('{"conversation_id":"conv-1"}', { status: 200 }));
        const resolveAttemptIdForConversation = mock(() => 'attempt-1');
        const runner = new ProactiveFetchRunner(
            originalFetch as unknown as typeof fetch,
            resolveAttemptIdForConversation,
            emitter,
            100,
        );
        const runnerInternal = runner as unknown as {
            successAtByKey: Map<string, number>;
            headersByKey: Map<string, Record<string, string>>;
            fetcher: { withInFlight: (key: string, callback: () => Promise<unknown>) => Promise<unknown> };
        };
        const key = 'TestPlatform:conv-1';

        runnerInternal.fetcher.withInFlight = async (_key: string, callback: () => Promise<unknown>) => {
            runnerInternal.successAtByKey.set(key, Date.now());
            return callback();
        };

        await runner.trigger(adapter, 'https://example.com/complete/conv-1', { authorization: 'Bearer test' });

        expect(originalFetch).toHaveBeenCalledTimes(0);
        expect(emitter.emitCapturePayload).toHaveBeenCalledTimes(0);
        expect(runnerInternal.headersByKey.has(key)).toBeFalse();
    });

    it('should abort the entire backoff loop when all URL candidates return 404', async () => {
        const adapter = createAdapter();
        const emitter = createEmitterDeps();
        const originalFetch = mock(async () => new Response('Not Found', { status: 404 }));
        const resolveAttemptIdForConversation = mock(() => 'attempt-1');
        const runner = new ProactiveFetchRunner(
            originalFetch as unknown as typeof fetch,
            resolveAttemptIdForConversation,
            emitter,
            100,
        );

        await runner.trigger(adapter, 'https://example.com/complete/conv-1');

        // Adapter has one candidate — one 404 means all candidates returned 404, abort backoff
        expect(originalFetch).toHaveBeenCalledTimes(1);
        expect(emitter.emitCapturePayload).not.toHaveBeenCalled();
    });

    it('should succeed if a later URL candidate succeeds after first returns 404', async () => {
        // Simulates stream_handoff models: /backend-api/conversation/{id} returns 404
        // but /backend-api/f/conversation/{id} works
        const adapter: LLMPlatform = {
            ...createAdapter(),
            buildApiUrl: (id: string) => `https://example.com/api/${id}`,
            buildApiUrls: (id: string) => [`https://example.com/api/${id}`, `https://example.com/api-f/${id}`],
        };
        const originalFetch = mock(async (url: unknown) => {
            if ((url as string).includes('/api-f/')) {
                return new Response('{"conversation_id":"conv-1"}', { status: 200 });
            }
            return new Response('Not Found', { status: 404 });
        });
        const emitter = createEmitterDeps();
        const resolveAttemptIdForConversation = mock(() => 'attempt-1');
        const runner = new ProactiveFetchRunner(
            originalFetch as unknown as typeof fetch,
            resolveAttemptIdForConversation,
            emitter,
            100,
        );

        await runner.trigger(adapter, 'https://example.com/complete/conv-1');

        // Both URLs tried — 404 on primary shouldn't abort before trying /f/ variant
        expect(originalFetch).toHaveBeenCalledTimes(2);
        expect(emitter.emitCapturePayload).toHaveBeenCalledTimes(1);
    });

    it('should not trigger when isExtensionEnabled returns false', async () => {
        const adapter = createAdapter();
        const emitter = createEmitterDeps();
        const originalFetch = mock(async () => new Response('{"conversation_id":"conv-1"}', { status: 200 }));
        const resolveAttemptIdForConversation = mock(() => 'attempt-1');
        const runner = new ProactiveFetchRunner(
            originalFetch as unknown as typeof fetch,
            resolveAttemptIdForConversation,
            emitter,
            100,
            () => false,
        );

        await runner.trigger(adapter, 'https://example.com/complete/conv-1');

        expect(originalFetch).not.toHaveBeenCalled();
        expect(emitter.emitCapturePayload).not.toHaveBeenCalled();
    });

    it('should abort backoff loop when isExtensionEnabled becomes false mid-loop', async () => {
        const adapter = createAdapter();
        const emitter = createEmitterDeps();
        let enabled = true;
        let callCount = 0;
        const originalFetch = mock(async () => {
            callCount++;
            if (callCount === 1) {
                enabled = false;
            }
            return new Response('Server Error', { status: 500 });
        });
        const resolveAttemptIdForConversation = mock(() => 'attempt-1');
        const runner = new ProactiveFetchRunner(
            originalFetch as unknown as typeof fetch,
            resolveAttemptIdForConversation,
            emitter,
            100,
            () => enabled,
        );

        await runner.trigger(adapter, 'https://example.com/complete/conv-1');

        expect(originalFetch).toHaveBeenCalledTimes(1);
    });

    it('should retry on non-404 errors (e.g. 500)', async () => {
        const adapter = createAdapter();
        const emitter = createEmitterDeps();
        let callCount = 0;
        const originalFetch = mock(async () => {
            callCount++;
            if (callCount <= 2) {
                return new Response('Server Error', { status: 500 });
            }
            return new Response('{"conversation_id":"conv-1"}', { status: 200 });
        });
        const resolveAttemptIdForConversation = mock(() => 'attempt-1');
        const runner = new ProactiveFetchRunner(
            originalFetch as unknown as typeof fetch,
            resolveAttemptIdForConversation,
            emitter,
            100,
        );

        await runner.trigger(adapter, 'https://example.com/complete/conv-1');

        // Should have retried past 500 errors and eventually succeeded
        expect(originalFetch).toHaveBeenCalledTimes(3);
        expect(emitter.emitCapturePayload).toHaveBeenCalledTimes(1);
    });
});
