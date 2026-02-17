import { beforeAll, describe, expect, it } from 'bun:test';

type GeminiLoadendGuard = (
    state: { emittedCompleted: boolean; emittedStreaming: boolean; seedConversationId?: string },
    requestUrl: string,
) => boolean;

describe('interceptor.content Gemini XHR completion guard', () => {
    let shouldEmitGeminiXhrLoadendCompletion: GeminiLoadendGuard;

    beforeAll(async () => {
        (globalThis as any).defineContentScript = (config: unknown) => config;
        const mod = await import('../entrypoints/interceptor.content');
        shouldEmitGeminiXhrLoadendCompletion = mod.shouldEmitGeminiXhrLoadendCompletion as GeminiLoadendGuard;
    });

    it('emits completed once for the same Gemini XHR state', () => {
        const state = {
            emittedCompleted: false,
            emittedStreaming: true,
            seedConversationId: 'gem-conv-1',
        };
        const streamGenerateUrl =
            'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';

        expect(shouldEmitGeminiXhrLoadendCompletion(state, streamGenerateUrl)).toBe(true);
        expect(state.emittedCompleted).toBe(true);
        expect(shouldEmitGeminiXhrLoadendCompletion(state, streamGenerateUrl)).toBe(false);
    });

    it('does not emit completed without streaming or conversation context', () => {
        const state = {
            emittedCompleted: false,
            emittedStreaming: false,
        };
        const streamGenerateUrl =
            'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';
        expect(shouldEmitGeminiXhrLoadendCompletion(state, streamGenerateUrl)).toBe(false);
    });
});
