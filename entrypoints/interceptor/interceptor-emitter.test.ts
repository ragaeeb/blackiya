import { beforeEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import { createInterceptorEmitter } from '@/entrypoints/interceptor/interceptor-emitter';
import { setSessionToken } from '@/utils/protocol/session-token';

describe('interceptor emitter prompt hints', () => {
    const windowInstance = new Window();

    beforeEach(() => {
        (globalThis as any).window = windowInstance;
        setSessionToken('bk:test-interceptor-emitter');
    });

    it('should include promptHint in emitted capture payload when cached for attempt', () => {
        const captureQueue: Array<Record<string, unknown>> = [];
        const logQueue: Array<Record<string, unknown>> = [];

        const emitter = createInterceptorEmitter({
            state: {
                completionSignalCache: new Map<string, number>(),
                transientLogCache: new Map<string, number>(),
                capturePayloadCache: new Map<string, number>(),
                lifecycleSignalCache: new Map<string, number>(),
                conversationResolvedSignalCache: new Map<string, number>(),
                promptHintByAttempt: new Map<string, string>(),
                streamDumpFrameCountByAttempt: new Map<string, number>(),
                streamDumpLastTextByAttempt: new Map<string, string>(),
                lastCachePruneAtMs: 0,
                streamDumpEnabled: false,
            },
            maxDedupeEntries: 50,
            maxStreamDumpAttempts: 20,
            cacheTtlMs: 60_000,
            cachePruneIntervalMs: 10_000,
            defaultPlatformName: 'Grok',
            resolveAttemptIdForConversation: () => 'grok:attempt-1',
            bindAttemptToConversation: () => {},
            isAttemptDisposed: () => false,
            appendToLogQueue: (message) => {
                logQueue.push(message as unknown as Record<string, unknown>);
            },
            appendToCaptureQueue: (message) => {
                captureQueue.push(message as unknown as Record<string, unknown>);
            },
        });

        emitter.cachePromptHintForAttempt('grok:attempt-1', 'Original user prompt');
        emitter.emitCapturePayload('https://x.com/2/grok/add_response.json', '{"ok":true}', 'Grok', 'grok:attempt-1');

        expect(logQueue).toHaveLength(0);
        expect(captureQueue).toHaveLength(1);
        expect(captureQueue[0]?.promptHint).toBe('Original user prompt');
    });
});
