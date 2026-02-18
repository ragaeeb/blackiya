import { describe, expect, it } from 'bun:test';
import { createFetchInterceptorContext } from '@/entrypoints/interceptor/fetch-pipeline';
import type { LLMPlatform } from '@/platforms/types';

const geminiAdapter = { name: 'Gemini' } as LLMPlatform;
const grokAdapter = { name: 'Grok' } as LLMPlatform;

describe('fetch pipeline helpers', () => {
    it('builds ChatGPT prompt context with generated lifecycle attempt', () => {
        const args = [
            'https://chatgpt.com/backend-api/f/conversation?x=1',
            {
                method: 'POST',
                body: JSON.stringify({ conversation_id: 'chat-conv-1' }),
            },
        ] as Parameters<typeof fetch>;
        const context = createFetchInterceptorContext(args, {
            getRequestUrl: (input) => String(input),
            getRequestMethod: (fetchArgs) => String(fetchArgs[1]?.method ?? 'GET'),
            getPlatformAdapterByApiUrl: () => null,
            chatGptPlatformName: 'ChatGPT',
            shouldEmitNonChatLifecycleForRequest: () => false,
            resolveRequestConversationId: () => undefined,
            peekAttemptIdForConversation: () => 'unused',
            resolveAttemptIdForConversation: () => 'unused',
            resolveLifecycleConversationId: () => 'chat-conv-1',
            safePathname: (url) => new URL(url).pathname,
        });
        expect(context.isChatGptPromptRequest).toBeTrue();
        expect(context.lifecycleConversationId).toBe('chat-conv-1');
        expect(context.lifecycleAttemptId?.startsWith('chatgpt:')).toBeTrue();
    });

    it('builds ChatGPT prompt context for non-/f conversation path', () => {
        const args = [
            'https://chatgpt.com/backend-api/conversation?x=1',
            {
                method: 'POST',
                body: JSON.stringify({ conversation_id: 'chat-conv-2' }),
            },
        ] as Parameters<typeof fetch>;
        const context = createFetchInterceptorContext(args, {
            getRequestUrl: (input) => String(input),
            getRequestMethod: (fetchArgs) => String(fetchArgs[1]?.method ?? 'GET'),
            getPlatformAdapterByApiUrl: () => null,
            chatGptPlatformName: 'ChatGPT',
            shouldEmitNonChatLifecycleForRequest: () => false,
            resolveRequestConversationId: () => undefined,
            peekAttemptIdForConversation: () => 'unused',
            resolveAttemptIdForConversation: () => 'unused',
            resolveLifecycleConversationId: () => 'chat-conv-2',
            safePathname: (url) => new URL(url).pathname,
        });
        expect(context.isChatGptPromptRequest).toBeTrue();
        expect(context.lifecycleConversationId).toBe('chat-conv-2');
        expect(context.lifecycleAttemptId?.startsWith('chatgpt:')).toBeTrue();
    });

    it('builds non-ChatGPT context with attempt binding metadata', () => {
        const args = [
            'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
            { method: 'POST' },
        ] as Parameters<typeof fetch>;
        const context = createFetchInterceptorContext(args, {
            getRequestUrl: (input) => String(input),
            getRequestMethod: (fetchArgs) => String(fetchArgs[1]?.method ?? 'GET'),
            getPlatformAdapterByApiUrl: () => geminiAdapter,
            chatGptPlatformName: 'ChatGPT',
            shouldEmitNonChatLifecycleForRequest: () => true,
            resolveRequestConversationId: () => 'gem-conv-1',
            peekAttemptIdForConversation: (conversationId, platformName) => `${platformName}:${conversationId}`,
            resolveAttemptIdForConversation: (conversationId, platformName) => `${platformName}:${conversationId}`,
            resolveLifecycleConversationId: () => undefined,
            safePathname: (url) => new URL(url).pathname,
        });
        expect(context.isNonChatGptApiRequest).toBeTrue();
        expect(context.shouldEmitNonChatLifecycle).toBeTrue();
        expect(context.nonChatConversationId).toBe('gem-conv-1');
        expect(context.nonChatAttemptId).toBe('Gemini:gem-conv-1');
    });

    it('does not mark non-prompt ChatGPT POST paths as prompt requests', () => {
        const args = [
            'https://chatgpt.com/backend-api/conversation/123/stream_status',
            {
                method: 'POST',
                body: JSON.stringify({ conversation_id: 'chat-conv-1' }),
            },
        ] as Parameters<typeof fetch>;
        const context = createFetchInterceptorContext(args, {
            getRequestUrl: (input) => String(input),
            getRequestMethod: (fetchArgs) => String(fetchArgs[1]?.method ?? 'GET'),
            getPlatformAdapterByApiUrl: () => null,
            chatGptPlatformName: 'ChatGPT',
            shouldEmitNonChatLifecycleForRequest: () => false,
            resolveRequestConversationId: () => undefined,
            peekAttemptIdForConversation: () => 'unused',
            resolveAttemptIdForConversation: () => 'unused',
            resolveLifecycleConversationId: () => 'chat-conv-1',
            safePathname: (url) => new URL(url).pathname,
        });
        expect(context.isChatGptPromptRequest).toBeFalse();
        expect(context.lifecycleConversationId).toBeUndefined();
        expect(context.lifecycleAttemptId).toBeUndefined();
    });

    it('builds non-chat stream context for GET Grok reconnect without lifecycle emission', () => {
        const args = [
            'https://grok.com/rest/app-chat/conversations/reconnect-response-v2/resp-123',
            { method: 'GET' },
        ] as Parameters<typeof fetch>;
        const context = createFetchInterceptorContext(args, {
            getRequestUrl: (input) => String(input),
            getRequestMethod: (fetchArgs) => String(fetchArgs[1]?.method ?? 'GET'),
            getPlatformAdapterByApiUrl: () => grokAdapter,
            chatGptPlatformName: 'ChatGPT',
            shouldEmitNonChatLifecycleForRequest: () => true,
            resolveRequestConversationId: () => 'grok-conv-1',
            peekAttemptIdForConversation: (conversationId, platformName) => `${platformName}:${conversationId}`,
            resolveAttemptIdForConversation: (conversationId, platformName) => `${platformName}:${conversationId}`,
            resolveLifecycleConversationId: () => undefined,
            safePathname: (url) => new URL(url).pathname,
        });
        expect(context.isNonChatGptApiRequest).toBeTrue();
        expect(context.fetchApiAdapter?.name).toBe('Grok');
        expect(context.shouldEmitNonChatLifecycle).toBeFalse();
        expect(context.nonChatConversationId).toBe('grok-conv-1');
        expect(context.nonChatAttemptId).toBe('Grok:grok-conv-1');
    });

    it('resolves fallback attempt id for GET Grok reconnect when no active attempt is cached', () => {
        const args = [
            'https://grok.com/rest/app-chat/conversations/reconnect-response-v2/resp-456',
            { method: 'GET' },
        ] as Parameters<typeof fetch>;
        const context = createFetchInterceptorContext(args, {
            getRequestUrl: (input) => String(input),
            getRequestMethod: (fetchArgs) => String(fetchArgs[1]?.method ?? 'GET'),
            getPlatformAdapterByApiUrl: () => grokAdapter,
            chatGptPlatformName: 'ChatGPT',
            shouldEmitNonChatLifecycleForRequest: () => false,
            resolveRequestConversationId: () => 'grok-conv-2',
            peekAttemptIdForConversation: () => undefined,
            resolveAttemptIdForConversation: (conversationId, platformName) =>
                `resolved:${platformName}:${conversationId ?? 'unknown'}`,
            resolveLifecycleConversationId: () => undefined,
            safePathname: (url) => new URL(url).pathname,
        });
        expect(context.nonChatAttemptId).toBe('resolved:Grok:grok-conv-2');
        expect(context.shouldEmitNonChatLifecycle).toBeFalse();
    });

    it('does not treat non-stream Grok GET requests as non-chat api requests', () => {
        const args = ['https://grok.com/rest/app-chat/conversations', { method: 'GET' }] as Parameters<typeof fetch>;
        const context = createFetchInterceptorContext(args, {
            getRequestUrl: (input) => String(input),
            getRequestMethod: (fetchArgs) => String(fetchArgs[1]?.method ?? 'GET'),
            getPlatformAdapterByApiUrl: () => grokAdapter,
            chatGptPlatformName: 'ChatGPT',
            shouldEmitNonChatLifecycleForRequest: () => true,
            resolveRequestConversationId: () => 'grok-conv-list',
            peekAttemptIdForConversation: () => 'should-not-be-used',
            resolveAttemptIdForConversation: () => 'should-not-be-used',
            resolveLifecycleConversationId: () => undefined,
            safePathname: (url) => new URL(url).pathname,
        });

        expect(context.fetchApiAdapter).toBeNull();
        expect(context.isNonChatGptApiRequest).toBeFalse();
        expect(context.nonChatAttemptId).toBeUndefined();
        expect(context.shouldEmitNonChatLifecycle).toBeFalse();
    });
});
