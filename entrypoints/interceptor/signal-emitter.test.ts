import { describe, expect, it } from 'bun:test';
import {
    shouldEmitGeminiXhrLoadendCompletion,
    shouldEmitXhrRequestLifecycle,
} from '@/entrypoints/interceptor/signal-emitter';

describe('interceptor signal emitter guards', () => {
    it('allows Gemini lifecycle emission before conversation id resolves', () => {
        expect(
            shouldEmitXhrRequestLifecycle({
                shouldEmitNonChatLifecycle: true,
                requestAdapter: { name: 'Gemini' },
                attemptId: 'gemini:attempt-1',
                conversationId: undefined,
            }),
        ).toBe(true);
        expect(
            shouldEmitXhrRequestLifecycle({
                shouldEmitNonChatLifecycle: true,
                requestAdapter: { name: 'Grok' },
                attemptId: 'grok:attempt-1',
                conversationId: undefined,
            }),
        ).toBe(false);
    });

    it('emits Gemini loadend completion once and requires generation context', () => {
        const state = {
            emittedCompleted: false,
            emittedStreaming: true,
            seedConversationId: 'conv-1',
        };
        const url =
            'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';
        expect(shouldEmitGeminiXhrLoadendCompletion(state, url)).toBe(true);
        expect(shouldEmitGeminiXhrLoadendCompletion(state, url)).toBe(false);
        const noContextState = { emittedCompleted: false, emittedStreaming: false };
        expect(shouldEmitGeminiXhrLoadendCompletion(noContextState, url)).toBe(false);
    });
});
