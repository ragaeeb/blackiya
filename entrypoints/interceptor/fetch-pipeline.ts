import { CHATGPT_PROMPT_REQUEST_PATH_PATTERN } from '@/platforms/chatgpt';
import type { LLMPlatform } from '@/platforms/types';
import { isGrokStreamingEndpoint } from '@/utils/grok-request-classifier';
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

export type CreateFetchInterceptorContextDeps = {
    getRequestUrl: (input: Parameters<typeof fetch>[0]) => string;
    getRequestMethod: (args: Parameters<typeof fetch>) => string;
    getPlatformAdapterByApiUrl: (url: string) => LLMPlatform | null;
    chatGptPlatformName: string;
    shouldEmitNonChatLifecycleForRequest: (adapter: LLMPlatform, url: string) => boolean;
    resolveRequestConversationId: (adapter: LLMPlatform, requestUrl: string) => string | undefined;
    peekAttemptIdForConversation: (conversationId?: string, platformName?: string) => string | undefined;
    resolveAttemptIdForConversation: (conversationId?: string, platformName?: string) => string;
    resolveLifecycleConversationId: (args: Parameters<typeof fetch>) => string | undefined;
    safePathname: (url: string) => string;
};

const shouldResolveAttemptForRequest = (adapter: LLMPlatform | null, method: string, url: string) => {
    return !!adapter && (method === 'POST' || (adapter.name === 'Grok' && isGrokStreamingEndpoint(url)));
};

const resolveNonChatAttemptId = (
    adapter: LLMPlatform,
    conversationId: string | undefined,
    deps: Pick<CreateFetchInterceptorContextDeps, 'peekAttemptIdForConversation' | 'resolveAttemptIdForConversation'>,
) => {
    const peeked = deps.peekAttemptIdForConversation(conversationId, adapter.name);
    if (peeked) {
        return peeked;
    }
    return deps.resolveAttemptIdForConversation(conversationId, adapter.name);
};

export const createFetchInterceptorContext = (
    args: Parameters<typeof fetch>,
    deps: CreateFetchInterceptorContextDeps,
): FetchInterceptorContext => {
    const outgoingUrl = deps.getRequestUrl(args[0]);
    const outgoingMethod = deps.getRequestMethod(args).toUpperCase();
    const outgoingPath = deps.safePathname(outgoingUrl);
    const detectedAdapter = deps.getPlatformAdapterByApiUrl(outgoingUrl);
    const fetchApiAdapter = shouldResolveAttemptForRequest(detectedAdapter, outgoingMethod, outgoingUrl)
        ? detectedAdapter
        : null;
    const isNonChatGptApiRequest = !!fetchApiAdapter && fetchApiAdapter.name !== deps.chatGptPlatformName;
    const shouldEmitNonChatLifecycle =
        outgoingMethod === 'POST' && isNonChatGptApiRequest && fetchApiAdapter
            ? deps.shouldEmitNonChatLifecycleForRequest(fetchApiAdapter, outgoingUrl)
            : false;
    const nonChatConversationId =
        isNonChatGptApiRequest && fetchApiAdapter
            ? deps.resolveRequestConversationId(fetchApiAdapter, outgoingUrl)
            : undefined;
    const nonChatAttemptId =
        isNonChatGptApiRequest && fetchApiAdapter
            ? resolveNonChatAttemptId(fetchApiAdapter, nonChatConversationId, deps)
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
};
