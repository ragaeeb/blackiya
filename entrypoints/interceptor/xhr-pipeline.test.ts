import { describe, expect, it } from 'bun:test';
import { buildXhrLifecycleContext } from '@/entrypoints/interceptor/xhr-pipeline';
import type { LLMPlatform } from '@/platforms/types';

const grokAdapter = { name: 'Grok' } as LLMPlatform;

describe('xhr pipeline helpers', () => {
    it('builds context with non-chat lifecycle metadata for POST API requests', () => {
        const xhr = {
            _method: 'POST',
            _url: 'https://grok.com/rest/app-chat/conversations/new',
        } as unknown as XMLHttpRequest;
        const context = buildXhrLifecycleContext(xhr, {
            getPlatformAdapterByApiUrl: () => grokAdapter,
            chatGptPlatformName: 'ChatGPT',
            shouldEmitNonChatLifecycleForRequest: () => true,
            resolveRequestConversationId: () => 'grok-conv-1',
            resolveAttemptIdForConversation: (conversationId, platformName) => `${platformName}:${conversationId}`,
        });
        expect(context.methodUpper).toBe('POST');
        expect(context.requestAdapter?.name).toBe('Grok');
        expect(context.shouldEmitNonChatLifecycle).toBe(true);
        expect(context.conversationId).toBe('grok-conv-1');
        expect(context.attemptId).toBe('Grok:grok-conv-1');
    });

    it('returns inert context for non-POST requests', () => {
        const xhr = {
            _method: 'GET',
            _url: 'https://example.com/health',
        } as unknown as XMLHttpRequest;
        const context = buildXhrLifecycleContext(xhr, {
            getPlatformAdapterByApiUrl: () => grokAdapter,
            chatGptPlatformName: 'ChatGPT',
            shouldEmitNonChatLifecycleForRequest: () => true,
            resolveRequestConversationId: () => 'ignored',
            resolveAttemptIdForConversation: () => 'ignored',
        });
        expect(context.requestAdapter).toBeNull();
        expect(context.shouldEmitNonChatLifecycle).toBe(false);
        expect(context.attemptId).toBeUndefined();
    });
});
