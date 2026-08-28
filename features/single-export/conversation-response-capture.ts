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
    canMutate?: (platformName: string) => boolean;
    onNonTerminal?: (platformName: string, conversationId: string) => void;
    transformText?: (text: string) => Promise<string | null>;
};

const isTerminal = (adapter: LLMPlatform, data: Parameters<ConversationResponseCache['set']>[1]) => {
    if (!adapter.evaluateReadiness) {
        return true;
    }
    const readiness = adapter.evaluateReadiness(data);
    return readiness.ready && readiness.terminal;
};

const normalizeCaptureUrl = (url: string, pageUrl: string): string => {
    try {
        return new URL(url, pageUrl).href;
    } catch {
        return url;
    }
};

const resolveEligibleAdapter = (input: Omit<CaptureInput, 'response'>): LLMPlatform | null => {
    const captureUrl = normalizeCaptureUrl(input.url, input.pageUrl);
    const adapter = input.resolveAdapter(captureUrl) ?? input.resolveAdapter(input.pageUrl);
    if (!adapter) {
        return null;
    }
    if (
        adapter.isConversationDetailRequest &&
        !adapter.isConversationDetailRequest(captureUrl, input.method, input.requestHeaders)
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
    if (!isTextWithinByteLimit(input.text, input.cache.getMaxBytesPerEntry())) {
        return false;
    }
    try {
        const parsed = adapter.parseInterceptedData(input.text, normalizeCaptureUrl(input.url, input.pageUrl));
        if (!parsed) {
            return false;
        }
        if (input.canMutate && !input.canMutate(adapter.name)) {
            return false;
        }
        if (!isTerminal(adapter, parsed)) {
            if (input.onNonTerminal) {
                input.onNonTerminal(adapter.name, parsed.conversation_id);
            } else {
                input.cache.delete(adapter.name, parsed.conversation_id);
            }
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

const getDeclaredByteLength = (source: Pick<Response, 'headers'> | Pick<Request, 'headers'>): number | null => {
    const value = source.headers?.get('content-length');
    if (!value || !/^\d+$/.test(value)) {
        return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

export const isDeclaredBodyOversized = (
    source: Pick<Response, 'headers'> | Pick<Request, 'headers'>,
    maxBytes: number,
): boolean => {
    const declaredByteLength = getDeclaredByteLength(source);
    return declaredByteLength !== null && declaredByteLength > maxBytes;
};

export const isTextWithinByteLimit = (text: string, maxBytes: number): boolean => {
    if (text.length > maxBytes) {
        return false;
    }
    return new TextEncoder().encode(text).byteLength <= maxBytes;
};

const cancelReader = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
    try {
        void reader.cancel().catch(() => undefined);
    } catch {}
};

export const readBoundedBodyText = async (
    source: Pick<Response, 'body' | 'headers'> | Pick<Request, 'body' | 'headers'>,
    maxBytes: number,
): Promise<string | null> => {
    if (!source.body || isDeclaredBodyOversized(source, maxBytes)) {
        return null;
    }
    const reader = source.body.getReader();
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
    if (isDeclaredBodyOversized(input.response, maxBytes)) {
        return false;
    }
    try {
        const capturedText = await readBoundedBodyText(input.response.clone(), maxBytes);
        if (capturedText === null) {
            return false;
        }
        const text = input.transformText ? await input.transformText(capturedText) : capturedText;
        if (text === null) {
            return false;
        }
        return captureWithAdapter(adapter, { ...input, text });
    } catch {
        return false;
    }
};
