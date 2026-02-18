import { describe, expect, it } from 'bun:test';

import {
    isGrokCompletionCandidateEndpoint,
    isGrokGenerationEndpoint,
    shouldEmitGrokCompletion,
    shouldEmitGrokLifecycle,
} from '@/utils/grok-request-classifier';

describe('grok-request-classifier', () => {
    it('should classify conversations/new as generation but not completion candidate', () => {
        const url = 'https://grok.com/rest/app-chat/conversations/new';
        expect(isGrokGenerationEndpoint(url)).toBeTrue();
        expect(shouldEmitGrokLifecycle(url)).toBeTrue();
        expect(isGrokCompletionCandidateEndpoint(url)).toBeFalse();
        expect(shouldEmitGrokCompletion(url)).toBeFalse();
    });

    it('should classify x.com add_response as generation endpoint', () => {
        const url = 'https://x.com/2/grok/add_response.json';
        expect(isGrokGenerationEndpoint(url)).toBeTrue();
        expect(shouldEmitGrokLifecycle(url)).toBeTrue();
    });

    it('should classify response-node as completion candidate', () => {
        const url = 'https://grok.com/rest/app-chat/conversations/abc123/response-node?includeThreads=true';
        expect(isGrokCompletionCandidateEndpoint(url)).toBeTrue();
        expect(shouldEmitGrokCompletion(url)).toBeTrue();
        expect(shouldEmitGrokLifecycle(url)).toBeFalse();
    });

    it('should classify load-responses as completion candidate', () => {
        const url = 'https://grok.com/rest/app-chat/conversations/abc123/load-responses';
        expect(isGrokCompletionCandidateEndpoint(url)).toBeTrue();
        expect(shouldEmitGrokCompletion(url)).toBeTrue();
        expect(shouldEmitGrokLifecycle(url)).toBeFalse();
    });

    it('should reject reconnect-response-v2 as completion candidate', () => {
        const url = 'https://grok.com/rest/app-chat/conversations/reconnect-response-v2/uuid';
        expect(isGrokCompletionCandidateEndpoint(url)).toBeFalse();
        expect(shouldEmitGrokCompletion(url)).toBeFalse();
    });
});
