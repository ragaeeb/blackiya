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
        expect(isGrokGenerationEndpoint(url)).toBe(true);
        expect(shouldEmitGrokLifecycle(url)).toBe(true);
        expect(isGrokCompletionCandidateEndpoint(url)).toBe(false);
        expect(shouldEmitGrokCompletion(url)).toBe(false);
    });

    it('should classify x.com add_response as generation endpoint', () => {
        const url = 'https://x.com/2/grok/add_response.json';
        expect(isGrokGenerationEndpoint(url)).toBe(true);
        expect(shouldEmitGrokLifecycle(url)).toBe(true);
    });

    it('should classify response-node as completion candidate', () => {
        const url = 'https://grok.com/rest/app-chat/conversations/abc123/response-node?includeThreads=true';
        expect(isGrokCompletionCandidateEndpoint(url)).toBe(true);
        expect(shouldEmitGrokCompletion(url)).toBe(true);
        expect(shouldEmitGrokLifecycle(url)).toBe(false);
    });

    it('should classify load-responses as completion candidate', () => {
        const url = 'https://grok.com/rest/app-chat/conversations/abc123/load-responses';
        expect(isGrokCompletionCandidateEndpoint(url)).toBe(true);
        expect(shouldEmitGrokCompletion(url)).toBe(true);
        expect(shouldEmitGrokLifecycle(url)).toBe(false);
    });

    it('should reject reconnect-response-v2 as completion candidate', () => {
        const url = 'https://grok.com/rest/app-chat/conversations/reconnect-response-v2/uuid';
        expect(isGrokCompletionCandidateEndpoint(url)).toBe(false);
        expect(shouldEmitGrokCompletion(url)).toBe(false);
    });
});
