import { describe, expect, it } from 'bun:test';
import {
    detectPlatformFromHostname,
    isDiscoveryDiagnosticsEnabled,
    safePathname,
} from '@/entrypoints/interceptor/discovery';

describe('interceptor discovery helpers', () => {
    it('derives safe pathname and falls back on malformed URL input', () => {
        expect(safePathname('https://chatgpt.com/backend-api/f/conversation?x=1')).toBe('/backend-api/f/conversation');
        expect(safePathname('not-a-valid-url')).toContain('not-a-valid-url');
    });

    it('detects known platforms from hostname', () => {
        expect(detectPlatformFromHostname('chatgpt.com')).toBe('ChatGPT');
        expect(detectPlatformFromHostname('gemini.google.com')).toBe('Gemini');
        expect(detectPlatformFromHostname('grok.com')).toBe('Grok');
        expect(detectPlatformFromHostname('example.com')).toBe('Discovery');
    });

    it('reads discovery diagnostics flag safely from storage adapter', () => {
        const enabledStorage = { getItem: (key: string) => (key === 'blackiya.discovery' ? '1' : null) };
        const disabledStorage = { getItem: () => null };
        const throwingStorage = {
            getItem: () => {
                throw new Error('blocked');
            },
        };
        expect(isDiscoveryDiagnosticsEnabled(enabledStorage)).toBeTrue();
        expect(isDiscoveryDiagnosticsEnabled(disabledStorage)).toBeFalse();
        expect(isDiscoveryDiagnosticsEnabled(throwingStorage)).toBeFalse();
    });
});
