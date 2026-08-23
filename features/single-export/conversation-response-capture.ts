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
    if (new TextEncoder().encode(input.text).byteLength > input.cache.getMaxBytesPerEntry()) {
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

const getDeclaredByteLength = (response: Response): number | null => {
    const value = response.headers?.get('content-length');
    if (!value || !/^\d+$/.test(value)) {
        return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

const cancelReader = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
    try {
        void reader.cancel().catch(() => undefined);
    } catch {}
};

const readBoundedResponseText = async (response: Response, maxBytes: number): Promise<string | null> => {
    if (!response.body) {
        return null;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let observedBytes = 0;
    let text = '';
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
                text += decoder.decode();
                return text;
            }
            observedBytes += chunk.value.byteLength;
            if (observedBytes > maxBytes) {
                cancelReader(reader);
                return null;
            }
            text += decoder.decode(chunk.value, { stream: true });
        }
    } catch {
        cancelReader(reader);
        return null;
    }
};

export const captureTerminalConversationResponse = async (input: CaptureInput): Promise<boolean> => {
    if (!input.response.ok) {
        return false;
    }
    const adapter = resolveEligibleAdapter(input);
    if (!adapter) {
        return false;
    }
    const maxBytes = input.cache.getMaxBytesPerEntry();
    const declaredByteLength = getDeclaredByteLength(input.response);
    if (declaredByteLength !== null && declaredByteLength > maxBytes) {
        return false;
    }
    try {
        const text = await readBoundedResponseText(input.response.clone(), maxBytes);
        if (text === null) {
            return false;
        }
        return captureWithAdapter(adapter, { ...input, text });
    } catch {
        return false;
    }
};
