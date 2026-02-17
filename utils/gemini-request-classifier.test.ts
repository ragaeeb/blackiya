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
        expect(isGeminiGenerationEndpoint(url)).toBe(true);
        expect(shouldEmitGeminiLifecycle(url)).toBe(true);
        expect(shouldEmitGeminiCompletion(url)).toBe(true);
    });

    it('should not classify batchexecute poll rpc as generation endpoint', () => {
        const url = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ESY5D&rt=c';
        expect(isGeminiGenerationEndpoint(url)).toBe(false);
        expect(shouldEmitGeminiLifecycle(url)).toBe(false);
        expect(shouldEmitGeminiCompletion(url)).toBe(false);
    });

    it('should not classify titles rpc as generation endpoint', () => {
        const url = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&rt=c';
        expect(isGeminiGenerationEndpoint(url)).toBe(false);
        expect(shouldEmitGeminiLifecycle(url)).toBe(false);
        expect(shouldEmitGeminiCompletion(url)).toBe(false);
    });
});
