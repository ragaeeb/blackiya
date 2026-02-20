import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as geminiClassifier from '@/utils/gemini-request-classifier';
import * as grokClassifier from '@/utils/grok-request-classifier';
import {
    shouldEmitCompletionForParsedData,
    shouldEmitCompletionForUrl,
    shouldEmitLifecycleForRequest,
    shouldSuppressCompletion,
} from '@/entrypoints/interceptor/completion-policy';

describe('completion-policy', () => {
    let geminiCompletionSpy: ReturnType<typeof spyOn>;
    let geminiLifecycleSpy: ReturnType<typeof spyOn>;
    let grokCompletionSpy: ReturnType<typeof spyOn>;
    let grokLifecycleSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        geminiCompletionSpy = spyOn(geminiClassifier, 'shouldEmitGeminiCompletion').mockImplementation(
            (url: string) => url.includes('gemini-complete'),
        );
        geminiLifecycleSpy = spyOn(geminiClassifier, 'shouldEmitGeminiLifecycle').mockImplementation(
            (url: string) => url.includes('gemini-lifecycle'),
        );
        grokCompletionSpy = spyOn(grokClassifier, 'shouldEmitGrokCompletion').mockImplementation(
            (url: string) => url.includes('grok-complete'),
        );
        grokLifecycleSpy = spyOn(grokClassifier, 'shouldEmitGrokLifecycle').mockImplementation(
            (url: string) => url.includes('grok-lifecycle'),
        );
    });

    afterEach(() => {
        geminiCompletionSpy.mockRestore();
        geminiLifecycleSpy.mockRestore();
        grokCompletionSpy.mockRestore();
        grokLifecycleSpy.mockRestore();
    });

    describe('shouldEmitCompletionForUrl', () => {
        it('should check gemini specific urls', () => {
            const adapter = { name: 'Gemini' } as any;
            expect(shouldEmitCompletionForUrl(adapter, 'gemini-complete')).toBeTrue();
            expect(shouldEmitCompletionForUrl(adapter, 'gemini-other')).toBeFalse();
            expect(shouldEmitCompletionForUrl(adapter, '/_/BardChatUi/data/batchexecute?rpcids=MaZiqc')).toBeFalse(); // Titles endpoint
        });

        it('should check grok specific urls', () => {
            const adapter = { name: 'Grok' } as any;
            expect(shouldEmitCompletionForUrl(adapter, 'grok-complete')).toBeTrue();
            expect(shouldEmitCompletionForUrl(adapter, 'grok-other')).toBeFalse();
        });

        it('should return true for other adapters', () => {
            const adapter = { name: 'ChatGPT' } as any;
            expect(shouldEmitCompletionForUrl(adapter, 'any-url')).toBeTrue();
        });
    });

    describe('shouldSuppressCompletion', () => {
        it('should negate emit completion rule', () => {
            const adapter = { name: 'Gemini' } as any;
            expect(shouldSuppressCompletion(adapter, 'gemini-complete')).toBeFalse();
            expect(shouldSuppressCompletion(adapter, 'gemini-other')).toBeTrue();
        });
    });

    describe('shouldEmitCompletionForParsedData', () => {
        it('should return false if url rule rejects', () => {
            const adapter = { name: 'Gemini' } as any;
            expect(shouldEmitCompletionForParsedData(adapter, 'gemini-other', null)).toBeFalse();
        });

        it('should check readiness for Grok', () => {
            const adapter = { name: 'Grok', evaluateReadiness: (c: any) => ({ ready: c.isReady }) } as any;
            expect(shouldEmitCompletionForParsedData(adapter, 'grok-complete', null)).toBeFalse();
            expect(
                shouldEmitCompletionForParsedData(adapter, 'grok-complete', {
                    conversation_id: '1',
                    isReady: false,
                } as any),
            ).toBeFalse();
            expect(
                shouldEmitCompletionForParsedData(adapter, 'grok-complete', {
                    conversation_id: '1',
                    isReady: true,
                } as any),
            ).toBeTrue();
        });

        it('should return true for others if url is allowed', () => {
            const adapter = { name: 'ChatGPT' } as any;
            expect(shouldEmitCompletionForParsedData(adapter, 'any', null)).toBeTrue();
        });
    });

    describe('shouldEmitLifecycleForRequest', () => {
        it('should evaluate gemini constraints', () => {
            const onSupressed = mock(() => {});
            const adapter = { name: 'Gemini' } as any;
            expect(shouldEmitLifecycleForRequest(adapter, 'gemini-lifecycle', onSupressed)).toBeTrue();
            expect(shouldEmitLifecycleForRequest(adapter, 'other', onSupressed)).toBeFalse();
            expect(onSupressed).toHaveBeenCalledWith('/other');
        });

        it('should evaluate grok constraints', () => {
            const onSupressed = mock(() => {});
            const adapter = { name: 'Grok' } as any;
            expect(shouldEmitLifecycleForRequest(adapter, 'grok-lifecycle', onSupressed)).toBeTrue();
            expect(shouldEmitLifecycleForRequest(adapter, 'other', onSupressed)).toBeFalse();
            expect(onSupressed).toHaveBeenCalledWith('/other');
        });

        it('should allow all for other adapters', () => {
            const adapter = { name: 'ChatGPT' } as any;
            expect(shouldEmitLifecycleForRequest(adapter, 'any')).toBeTrue();
        });
    });
});
