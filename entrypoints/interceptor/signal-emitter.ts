import { shouldEmitGeminiCompletion } from '@/utils/gemini-request-classifier';

export function shouldEmitXhrRequestLifecycle(context: {
    shouldEmitNonChatLifecycle: boolean;
    requestAdapter: { name: string } | null;
    attemptId?: string;
    conversationId?: string;
}): boolean {
    if (!context.shouldEmitNonChatLifecycle || !context.requestAdapter || !context.attemptId) {
        return false;
    }
    if (context.requestAdapter.name === 'Gemini') {
        return true;
    }
    return typeof context.conversationId === 'string' && context.conversationId.length > 0;
}

export function tryEmitGeminiXhrLoadendCompletion(
    state: { emittedCompleted: boolean; emittedStreaming: boolean; seedConversationId?: string },
    requestUrl: string,
) {
    return tryMarkGeminiXhrLoadendCompleted(state, requestUrl);
}

export function tryMarkGeminiXhrLoadendCompleted(
    state: { emittedCompleted: boolean; emittedStreaming: boolean; seedConversationId?: string },
    requestUrl: string,
): boolean {
    if (state.emittedCompleted) {
        return false;
    }
    if (!shouldEmitGeminiCompletion(requestUrl)) {
        return false;
    }
    if (!state.emittedStreaming && !state.seedConversationId) {
        return false;
    }
    state.emittedCompleted = true;
    return true;
}
