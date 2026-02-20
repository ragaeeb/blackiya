import type { LLMPlatform } from '@/platforms/types';

export type XhrLifecycleContext = {
    methodUpper: string;
    requestUrl: string;
    requestAdapter: LLMPlatform | null;
    shouldEmitNonChatLifecycle: boolean;
    conversationId?: string;
    attemptId?: string;
};

export type BuildXhrLifecycleContextDeps = {
    getPlatformAdapterByApiUrl: (url: string) => LLMPlatform | null;
    chatGptPlatformName: string;
    shouldEmitNonChatLifecycleForRequest: (adapter: LLMPlatform, url: string) => boolean;
    resolveRequestConversationId: (adapter: LLMPlatform, requestUrl: string) => string | undefined;
    peekAttemptIdForConversation: (conversationId: string | undefined, platformName?: string) => string | undefined;
};

export const buildXhrLifecycleContext = (
    xhr: XMLHttpRequest,
    deps: BuildXhrLifecycleContextDeps,
): XhrLifecycleContext => {
    const method = ((xhr as any)._method as string | undefined) ?? 'GET';
    const requestUrl = ((xhr as any)._url as string | undefined) ?? '';
    const methodUpper = method.toUpperCase();
    const requestAdapter = methodUpper === 'POST' ? deps.getPlatformAdapterByApiUrl(requestUrl) : null;
    const shouldEmitNonChatLifecycle =
        !!requestAdapter &&
        requestAdapter.name !== deps.chatGptPlatformName &&
        deps.shouldEmitNonChatLifecycleForRequest(requestAdapter, requestUrl);
    const conversationId =
        shouldEmitNonChatLifecycle && requestAdapter
            ? deps.resolveRequestConversationId(requestAdapter, requestUrl)
            : undefined;
    const attemptId =
        shouldEmitNonChatLifecycle && requestAdapter
            ? deps.peekAttemptIdForConversation(conversationId, requestAdapter.name)
            : undefined;
    return {
        methodUpper,
        requestUrl,
        requestAdapter,
        shouldEmitNonChatLifecycle,
        conversationId,
        attemptId,
    };
};
