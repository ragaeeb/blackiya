import { isCapturedConversationReady } from '@/entrypoints/interceptor/conversation-utils';
import { safePathname } from '@/entrypoints/interceptor/discovery';
import type { LLMPlatform } from '@/platforms/types';
import { shouldEmitGeminiCompletion, shouldEmitGeminiLifecycle } from '@/utils/gemini-request-classifier';
import { shouldEmitGrokCompletion, shouldEmitGrokLifecycle } from '@/utils/grok-request-classifier';
import type { ConversationData } from '@/utils/types';

const isGeminiTitlesEndpoint = (url: string) =>
    /\/_\/BardChatUi\/data\/batchexecute/i.test(url) && /[?&]rpcids=MaZiqc(?:&|$)/i.test(url);

export const shouldEmitCompletionForUrl = (adapter: LLMPlatform, url: string) => {
    if (adapter.name === 'Gemini') {
        return !isGeminiTitlesEndpoint(url) && shouldEmitGeminiCompletion(url);
    }
    if (adapter.name === 'Grok') {
        return shouldEmitGrokCompletion(url);
    }
    return true;
};

export const shouldSuppressCompletion = (adapter: LLMPlatform, url: string) =>
    !shouldEmitCompletionForUrl(adapter, url);

export const shouldEmitCompletionForParsedData = (
    adapter: LLMPlatform,
    url: string,
    parsed: ConversationData | null,
) => {
    if (!shouldEmitCompletionForUrl(adapter, url)) {
        return false;
    }
    if (adapter.name === 'Grok') {
        return isCapturedConversationReady(adapter, parsed);
    }
    return true;
};

/**
 * Returns whether lifecycle signals should be emitted for a non-ChatGPT adapter request.
 * `onSuppressed` is called with the path when a platform-specific rule blocks emission,
 * giving callers a chance to log throttled suppression notices.
 */
export const shouldEmitLifecycleForRequest = (
    adapter: LLMPlatform,
    url: string,
    onSuppressed?: (path: string) => void,
) => {
    let allowed: boolean;
    if (adapter.name === 'Gemini') {
        allowed = shouldEmitGeminiLifecycle(url);
    } else if (adapter.name === 'Grok') {
        allowed = shouldEmitGrokLifecycle(url);
    } else {
        return true;
    }
    if (!allowed) {
        onSuppressed?.(safePathname(url));
    }
    return allowed;
};
