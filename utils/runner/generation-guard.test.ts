import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { detectChatGPTGenerating, detectPlatformGenerating } from '@/utils/runner/generation-guard';

describe('generation-guard', () => {
    let originalDocument: any;
    const mockedSelectors: Record<string, any> = {};

    beforeEach(() => {
        originalDocument = globalThis.document;
        (globalThis as any).document = {
            querySelector: (selector: string) => mockedSelectors[selector] || null,
        };
    });

    afterEach(() => {
        globalThis.document = originalDocument;
        for (const key of Object.keys(mockedSelectors)) {
            delete mockedSelectors[key];
        }
    });

    describe('detectChatGPTGenerating', () => {
        it('should return false if document.querySelector is not a function', () => {
            (globalThis as any).document.querySelector = undefined;
            expect(detectChatGPTGenerating()).toBeFalse();
        });

        it('should return true if stop button found and enabled', () => {
            mockedSelectors['[data-testid="stop-button"]'] = { disabled: false };
            expect(detectChatGPTGenerating()).toBeTrue();
        });

        it('should return false if stop button found but disabled', () => {
            mockedSelectors['[data-testid="stop-button"]'] = { disabled: true };
            expect(detectChatGPTGenerating()).toBeFalse();
        });

        it('should return true if streaming sentinel found', () => {
            mockedSelectors['[data-is-streaming="true"], [data-testid="streaming"]'] = { id: 'sentinel' };
            expect(detectChatGPTGenerating()).toBeTrue();
        });
    });

    describe('detectPlatformGenerating', () => {
        it('should return false if no adapter', () => {
            expect(detectPlatformGenerating(null)).toBeFalse();
        });

        it('should delegate to platform method if available', () => {
            const adapter = { isPlatformGenerating: () => true } as any;
            expect(detectPlatformGenerating(adapter)).toBeTrue();
        });

        it('should fallback to chatgpt query if name is ChatGPT', () => {
            mockedSelectors['[data-testid="stop-button"]'] = { disabled: false };
            const adapter = { name: 'ChatGPT' } as any; // No isPlatformGenerating provided
            expect(detectPlatformGenerating(adapter)).toBeTrue();
        });

        it('should return false for unrecognized adapter without check', () => {
            expect(detectPlatformGenerating({ name: 'Gemini' } as any)).toBeFalse();
        });
    });
});
