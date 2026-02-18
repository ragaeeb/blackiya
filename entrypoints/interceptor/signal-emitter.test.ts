import { describe, expect, it } from 'bun:test';
import {
    shouldEmitGeminiXhrLoadendCompletion,
    shouldEmitXhrRequestLifecycle,
    tryMarkGeminiXhrLoadendCompleted,
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
        ).toBeTrue();
        expect(
            shouldEmitXhrRequestLifecycle({
                shouldEmitNonChatLifecycle: true,
                requestAdapter: { name: 'Grok' },
                attemptId: 'grok:attempt-1',
                conversationId: undefined,
            }),
        ).toBeFalse();
    });

    it('tryMarkGeminiXhrLoadendCompleted emits Gemini loadend completion once and requires generation context', () => {
        const state = {
            emittedCompleted: false,
            emittedStreaming: true,
            seedConversationId: 'conv-1',
        };
        const url =
            'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';
        expect(tryMarkGeminiXhrLoadendCompleted(state, url)).toBeTrue();
        expect(tryMarkGeminiXhrLoadendCompleted(state, url)).toBeFalse();
        const noContextState = { emittedCompleted: false, emittedStreaming: false };
        expect(tryMarkGeminiXhrLoadendCompleted(noContextState, url)).toBeFalse();

        // only streaming active, no seedConversationId
        const streamingOnlyState = { emittedCompleted: false, emittedStreaming: true };
        expect(shouldEmitGeminiXhrLoadendCompletion(streamingOnlyState, url)).toBeTrue();

        // only seedConversationId present, streaming not yet observed
        const seedOnlyState = { emittedCompleted: false, emittedStreaming: false, seedConversationId: 'conv-seed' };
        expect(shouldEmitGeminiXhrLoadendCompletion(seedOnlyState, url)).toBeTrue();
    });

    it('keeps shouldEmitGeminiXhrLoadendCompletion backward-compatible as an alias', () => {
        const state = {
            emittedCompleted: false,
            emittedStreaming: true,
            seedConversationId: 'conv-2',
        };
        const url =
            'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';
        expect(shouldEmitGeminiXhrLoadendCompletion(state, url)).toBeTrue();
        expect(shouldEmitGeminiXhrLoadendCompletion(state, url)).toBeFalse();
    });
});
