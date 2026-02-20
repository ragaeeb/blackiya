import { describe, expect, it } from 'bun:test';
import {
    GEMINI_ENDPOINT_REGISTRY,
    isGeminiGenerationEndpointUrl,
    isGeminiTitlesEndpointUrl,
    isLikelyGeminiApiPath,
    resolveGeminiButtonInjectionTarget,
} from '@/platforms/gemini/registry';

describe('gemini registry', () => {
    it('should expose endpoint patterns matching StreamGenerate and batchexecute URLs', () => {
        expect(
            GEMINI_ENDPOINT_REGISTRY.apiEndpointPattern.test(
                'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?rt=c',
            ),
        ).toBeTrue();
        expect(
            GEMINI_ENDPOINT_REGISTRY.apiEndpointPattern.test(
                'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb',
            ),
        ).toBeTrue();
    });

    it('should classify generation and titles endpoints via shared helpers', () => {
        expect(
            isGeminiGenerationEndpointUrl(
                'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?rt=c',
            ),
        ).toBeTrue();
        expect(
            isGeminiTitlesEndpointUrl('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&rt=c'),
        ).toBeTrue();
        expect(
            isGeminiTitlesEndpointUrl('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ESY5D'),
        ).toBeFalse();
    });

    it('should resolve button injection target from configured selectors', () => {
        const parent = { id: 'parent' } as unknown as HTMLElement;
        const doc = {
            querySelector: (selector: string) =>
                selector === 'header nav' ? ({ parentElement: parent } as unknown as Element) : null,
        };
        expect(resolveGeminiButtonInjectionTarget(doc)).toBe(parent);
    });

    it('should classify likely gemini api paths for endpoint-miss diagnostics', () => {
        expect(isLikelyGeminiApiPath('https://gemini.google.com/_/BardChatUi/data/unknown')).toBeTrue();
        expect(isLikelyGeminiApiPath('https://gemini.google.com/app/123')).toBeFalse();
    });
});
