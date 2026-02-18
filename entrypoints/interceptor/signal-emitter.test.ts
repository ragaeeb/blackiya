import { describe, expect, it } from 'bun:test';
import {
    shouldEmitXhrRequestLifecycle,
    tryEmitGeminiXhrLoadendCompletion,
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
    });

    it('tryEmitGeminiXhrLoadendCompletion allows partial generation context states', () => {
        const url =
            'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';
        const streamingOnlyState = { emittedCompleted: false, emittedStreaming: true };
        expect(tryEmitGeminiXhrLoadendCompletion(streamingOnlyState, url)).toBeTrue();
        const seedOnlyState = { emittedCompleted: false, emittedStreaming: false, seedConversationId: 'conv-seed' };
        expect(tryEmitGeminiXhrLoadendCompletion(seedOnlyState, url)).toBeTrue();
    });

    it('tryEmitGeminiXhrLoadendCompletion emits once for the same state', () => {
        const state = {
            emittedCompleted: false,
            emittedStreaming: true,
            seedConversationId: 'conv-2',
        };
        const url =
            'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';
        expect(tryEmitGeminiXhrLoadendCompletion(state, url)).toBeTrue();
        expect(tryEmitGeminiXhrLoadendCompletion(state, url)).toBeFalse();
    });
});
