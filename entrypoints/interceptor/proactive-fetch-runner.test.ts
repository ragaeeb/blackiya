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
});
