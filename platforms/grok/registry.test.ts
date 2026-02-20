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
    it('should expose endpoint patterns matching x.com GraphQL and grok.com REST URLs', () => {
        expect(
            GROK_ENDPOINT_REGISTRY.apiEndpointPattern.test(
                'https://x.com/i/api/graphql/6QmFg/GrokConversationItemsByRestId?variables=%7B%7D',
            ),
        ).toBeTrue();
        expect(
            GROK_ENDPOINT_REGISTRY.apiEndpointPattern.test(
                'https://grok.com/rest/app-chat/conversations/01cb0729-6455-471d-b33a-124b3de76a29/load-responses',
            ),
        ).toBeTrue();
    });

    it('should classify generation, streaming, and completion candidate endpoints', () => {
        expect(isGrokGenerationEndpointUrl('https://grok.com/rest/app-chat/conversations/new')).toBeTrue();
        expect(
            isGrokStreamingEndpointUrl('https://grok.com/rest/app-chat/conversations/reconnect-response-v2/abc'),
        ).toBeTrue();
        expect(
            isGrokCompletionCandidateEndpointUrl(
                'https://grok.com/rest/app-chat/conversations/01cb0729-6455-471d-b33a-124b3de76a29/response-node',
            ),
        ).toBeTrue();
        expect(isGrokCompletionCandidateEndpointUrl('https://grok.com/rest/app-chat/conversations/new')).toBeFalse();
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
        expect(isLikelyGrokApiPath('https://x.com/i/api/graphql/abc/Unknown')).toBeTrue();
        expect(isLikelyGrokApiPath('https://x.com/i/grok?conversation=123')).toBeFalse();
    });
});
