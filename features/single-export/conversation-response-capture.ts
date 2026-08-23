import type { LLMPlatform } from '@/platforms/types';
import type { ConversationResponseCache } from './conversation-response-cache';

type CaptureInput = {
    response: Response;
    url: string;
    method: string;
    requestHeaders?: HeadersInit;
    pageUrl: string;
    resolveAdapter: (url: string) => LLMPlatform | null;
    cache: ConversationResponseCache;
};

const isTerminal = (adapter: LLMPlatform, data: Parameters<ConversationResponseCache['set']>[1]) => {
    if (!adapter.evaluateReadiness) {
        return true;
    }
    const readiness = adapter.evaluateReadiness(data);
    return readiness.ready && readiness.terminal;
};

const resolveEligibleAdapter = (input: Omit<CaptureInput, 'response'>): LLMPlatform | null => {
    const adapter = input.resolveAdapter(input.url) ?? input.resolveAdapter(input.pageUrl);
    if (!adapter) {
        return null;
    }
    if (
        adapter.isConversationDetailRequest &&
        !adapter.isConversationDetailRequest(input.url, input.method, input.requestHeaders)
    ) {
        return null;
    }
    return adapter;
};

const captureWithAdapter = (
    adapter: LLMPlatform,
    input: Omit<CaptureInput, 'response'> & { text: string },
): boolean => {
    if (!input.text) {
        return false;
    }
    try {
        const parsed = adapter.parseInterceptedData(input.text, input.url);
        if (!parsed || !isTerminal(adapter, parsed)) {
            return false;
        }
        return input.cache.set(adapter.name, parsed);
    } catch {
        return false;
    }
};

export const captureTerminalConversationText = (input: Omit<CaptureInput, 'response'> & { text: string }): boolean => {
    const adapter = resolveEligibleAdapter(input);
    return adapter ? captureWithAdapter(adapter, input) : false;
};

export const captureTerminalConversationResponse = async (input: CaptureInput): Promise<boolean> => {
    if (!input.response.ok) {
        return false;
    }
    const adapter = resolveEligibleAdapter(input);
    if (!adapter) {
        return false;
    }
    try {
        const text = await input.response.text();
        return captureWithAdapter(adapter, { ...input, text });
    } catch {
        return false;
    }
};
