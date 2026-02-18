import { describe, expect, it } from 'bun:test';
import {
    isGeminiGenerationEndpoint,
    shouldEmitGeminiCompletion,
    shouldEmitGeminiLifecycle,
} from '@/utils/gemini-request-classifier';

describe('gemini-request-classifier', () => {
    it('should classify StreamGenerate as generation endpoint', () => {
        const url =
            'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?rt=c';
        expect(isGeminiGenerationEndpoint(url)).toBeTrue();
        expect(shouldEmitGeminiLifecycle(url)).toBeTrue();
        expect(shouldEmitGeminiCompletion(url)).toBeTrue();
    });

    it('should not classify batchexecute poll rpc as generation endpoint', () => {
        const url = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ESY5D&rt=c';
        expect(isGeminiGenerationEndpoint(url)).toBeFalse();
        expect(shouldEmitGeminiLifecycle(url)).toBeFalse();
        expect(shouldEmitGeminiCompletion(url)).toBeFalse();
    });

    it('should not classify titles rpc as generation endpoint', () => {
        const url = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&rt=c';
        expect(isGeminiGenerationEndpoint(url)).toBeFalse();
        expect(shouldEmitGeminiLifecycle(url)).toBeFalse();
        expect(shouldEmitGeminiCompletion(url)).toBeFalse();
    });
});
