import { describe, expect, it } from 'bun:test';
import { resolveHeaderCaptureAdapter } from '@/entrypoints/interceptor/header-capture';
import type { LLMPlatform } from '@/platforms/types';

const makeAdapter = (name: string): LLMPlatform => ({
    name,
    urlMatchPattern: `https://${name.toLowerCase()}.example.com/*`,
    apiEndpointPattern: /.*/,
    isPlatformUrl: () => true,
    extractConversationId: () => null,
    parseInterceptedData: () => null,
    formatFilename: () => 'x',
    getButtonInjectionTarget: () => null,
});

describe('header-capture', () => {
    it('should prefer context adapter first', () => {
        const contextAdapter = makeAdapter('Context');
        const apiAdapter = makeAdapter('Api');
        const completionAdapter = makeAdapter('Completion');

        expect(resolveHeaderCaptureAdapter(contextAdapter, apiAdapter, completionAdapter)).toBe(contextAdapter);
    });

    it('should fall back to api adapter when context adapter is null', () => {
        const apiAdapter = makeAdapter('Api');
        const completionAdapter = makeAdapter('Completion');

        expect(resolveHeaderCaptureAdapter(null, apiAdapter, completionAdapter)).toBe(apiAdapter);
    });

    it('should fall back to completion adapter when others are null', () => {
        const completionAdapter = makeAdapter('Completion');

        expect(resolveHeaderCaptureAdapter(null, null, completionAdapter)).toBe(completionAdapter);
    });

    it('should return null when all adapters are null', () => {
        expect(resolveHeaderCaptureAdapter(null, null, null)).toBeNull();
    });
});
