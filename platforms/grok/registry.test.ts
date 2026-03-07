import { describe, expect, it } from 'bun:test';
import {
    GROK_ENDPOINT_REGISTRY,
    isGrokCompletionCandidateEndpointUrl,
    isGrokGenerationEndpointUrl,
    isGrokStreamingEndpointUrl,
    isLikelyGrokApiPath,
    resolveGrokButtonInjectionTarget,
} from '@/platforms/grok/registry';

describe('grok registry', () => {
    it('should expose endpoint patterns matching grok.x.com streaming and grok.com REST URLs', () => {
        expect(
            GROK_ENDPOINT_REGISTRY.apiEndpointPattern.test(
                'https://grok.x.com/2/grok/add_response.json',
            ),
        ).toBeTrue();
        expect(
            GROK_ENDPOINT_REGISTRY.apiEndpointPattern.test(
                'https://grok.com/rest/app-chat/conversations/01cb0729-6455-471d-b33a-124b3de76a29/load-responses',
            ),
        ).toBeTrue();
        expect(GROK_ENDPOINT_REGISTRY.apiEndpointPattern.test('https://x.com/2/grok/add_response.json')).toBeFalse();
        expect(
            GROK_ENDPOINT_REGISTRY.completionTriggerPattern.test('https://x.com/2/grok/add_response.json'),
        ).toBeFalse();
    });

    it('should classify generation, streaming, and completion candidate endpoints', () => {
        expect(isGrokGenerationEndpointUrl('https://grok.com/rest/app-chat/conversations/new')).toBeTrue();
        expect(isGrokGenerationEndpointUrl('https://grok.x.com/2/grok/add_response.json')).toBeTrue();
        expect(isGrokGenerationEndpointUrl('https://x.com/2/grok/add_response.json')).toBeFalse();
        expect(
            isGrokStreamingEndpointUrl('https://grok.com/rest/app-chat/conversations/reconnect-response-v2/abc'),
        ).toBeTrue();
        expect(isGrokStreamingEndpointUrl('https://grok.x.com/2/grok/add_response.json')).toBeTrue();
        expect(
            isGrokCompletionCandidateEndpointUrl(
                'https://grok.com/rest/app-chat/conversations/01cb0729-6455-471d-b33a-124b3de76a29/response-node',
            ),
        ).toBeTrue();
        expect(isGrokCompletionCandidateEndpointUrl('https://grok.com/rest/app-chat/conversations/new')).toBeFalse();
        expect(
            isGrokCompletionCandidateEndpointUrl('https://x.com/rest/app-chat/conversations/abc/response-node'),
        ).toBeFalse();
    });

    it('should resolve button injection target from configured selectors', () => {
        const parent = { id: 'parent' } as unknown as HTMLElement;
        const doc = {
            querySelector: (selector: string) =>
                selector === '[role="banner"]' ? ({ parentElement: parent } as unknown as Element) : null,
        };
        expect(resolveGrokButtonInjectionTarget(doc)).toBe(parent);
    });

    it('should classify likely grok api paths for endpoint-miss diagnostics', () => {
        expect(isLikelyGrokApiPath('https://grok.com/rest/app-chat/conversations/new')).toBeTrue();
        expect(isLikelyGrokApiPath('https://grok.x.com/2/grok/add_response.json')).toBeTrue();
        expect(isLikelyGrokApiPath('https://x.com/2/grok/add_response.json')).toBeFalse();
        expect(isLikelyGrokApiPath('https://grok.com/c/01cb0729-6455-471d-b33a-124b3de76a29')).toBeFalse();
    });
});
