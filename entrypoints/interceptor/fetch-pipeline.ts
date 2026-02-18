import { CHATGPT_PROMPT_REQUEST_PATH_PATTERN } from '@/platforms/chatgpt';
import type { LLMPlatform } from '@/platforms/types';
import { createAttemptId } from '@/utils/protocol/messages';

export type FetchInterceptorContext = {
    args: Parameters<typeof fetch>;
    outgoingUrl: string;
    outgoingMethod: string;
    outgoingPath: string;
    fetchApiAdapter: LLMPlatform | null;
    isNonChatGptApiRequest: boolean;
    shouldEmitNonChatLifecycle: boolean;
    nonChatConversationId: string | undefined;
    nonChatAttemptId: string | undefined;
    isChatGptPromptRequest: boolean;
    lifecycleConversationId: string | undefined;
    lifecycleAttemptId: string | undefined;
};

export interface CreateFetchInterceptorContextDeps {
    getRequestUrl: (input: Parameters<typeof fetch>[0]) => string;
    getRequestMethod: (args: Parameters<typeof fetch>) => string;
    getPlatformAdapterByApiUrl: (url: string) => LLMPlatform | null;
    chatGptPlatformName: string;
    shouldEmitNonChatLifecycleForRequest: (adapter: LLMPlatform, url: string) => boolean;
    resolveRequestConversationId: (adapter: LLMPlatform, requestUrl: string) => string | undefined;
    peekAttemptIdForConversation: (conversationId?: string, platformName?: string) => string | undefined;
    resolveLifecycleConversationId: (args: Parameters<typeof fetch>) => string | undefined;
    safePathname: (url: string) => string;
}

export function createFetchInterceptorContext(
    args: Parameters<typeof fetch>,
    deps: CreateFetchInterceptorContextDeps,
): FetchInterceptorContext {
    const outgoingUrl = deps.getRequestUrl(args[0]);
    const outgoingMethod = deps.getRequestMethod(args).toUpperCase();
    const outgoingPath = deps.safePathname(outgoingUrl);
    const fetchApiAdapter = outgoingMethod === 'POST' ? deps.getPlatformAdapterByApiUrl(outgoingUrl) : null;
    const isNonChatGptApiRequest = !!fetchApiAdapter && fetchApiAdapter.name !== deps.chatGptPlatformName;
    const shouldEmitNonChatLifecycle =
        isNonChatGptApiRequest && fetchApiAdapter
            ? deps.shouldEmitNonChatLifecycleForRequest(fetchApiAdapter, outgoingUrl)
            : false;
    const nonChatConversationId =
        isNonChatGptApiRequest && fetchApiAdapter
            ? deps.resolveRequestConversationId(fetchApiAdapter, outgoingUrl)
            : undefined;
    const nonChatAttemptId =
        isNonChatGptApiRequest && fetchApiAdapter
            ? deps.peekAttemptIdForConversation(nonChatConversationId, fetchApiAdapter.name)
            : undefined;
    const isChatGptPromptRequest = outgoingMethod === 'POST' && CHATGPT_PROMPT_REQUEST_PATH_PATTERN.test(outgoingPath);
    const lifecycleConversationId = isChatGptPromptRequest ? deps.resolveLifecycleConversationId(args) : undefined;
    const lifecycleAttemptId = isChatGptPromptRequest ? createAttemptId('chatgpt') : undefined;

    return {
        args,
        outgoingUrl,
        outgoingMethod,
        outgoingPath,
        fetchApiAdapter,
        isNonChatGptApiRequest,
        shouldEmitNonChatLifecycle,
        nonChatConversationId,
        nonChatAttemptId,
        isChatGptPromptRequest,
        lifecycleConversationId,
        lifecycleAttemptId,
    };
}
