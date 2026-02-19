import type { LLMPlatform } from '@/platforms/types';
import { isConversationReady } from '@/utils/conversation-readiness';
import type { ConversationData } from '@/utils/types';

// Conversation ID extraction

export const extractConversationIdFromChatGptUrl = (url: string) => url.match(/\/c\/([a-f0-9-]{36})/i)?.[1];

export const extractConversationIdFromAnyUrl = (url: string) =>
    url.match(/\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i)?.[1];

export const extractConversationIdFromRequestBody = (args: Parameters<typeof fetch>) => {
    const initBody = args[1]?.body;
    if (typeof initBody !== 'string') {
        return undefined;
    }
    try {
        const parsed = JSON.parse(initBody);
        const id: unknown = parsed?.conversation_id ?? parsed?.conversationId;
        if (!id || id === 'null' || typeof id !== 'string') {
            return undefined;
        }
        return /^[a-f0-9-]{36}$/i.test(id) ? id : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Best-effort conversation ID for lifecycle signals on the ChatGPT platform —
 * checks the request body first, then the current page URL.
 */
export const resolveLifecycleConversationId = (args: Parameters<typeof fetch>) =>
    extractConversationIdFromRequestBody(args) ?? extractConversationIdFromChatGptUrl(window.location.href);

/** Resolves the conversation ID for a given adapter from the request URL or current page URL. */
export const resolveRequestConversationId = (adapter: LLMPlatform, requestUrl: string) =>
    adapter.extractConversationIdFromUrl?.(requestUrl) ??
    adapter.extractConversationId(window.location.href) ??
    undefined;

// Conversation data parsing

export const parseConversationData = (adapter: LLMPlatform, payload: string, url: string) => {
    try {
        return adapter.parseInterceptedData(payload, url);
    } catch {
        return null;
    }
};

export const resolveParsedConversationId = (
    adapter: LLMPlatform,
    parsed: ConversationData | null,
    url: string,
): string | undefined =>
    parsed?.conversation_id ?? adapter.extractConversationIdFromUrl?.(url) ?? extractConversationIdFromAnyUrl(url);

/** Returns the text of the most recently updated assistant message, or null. */
export const extractLatestAssistantText = (parsed: ConversationData): string | null => {
    const messages = Object.values(parsed.mapping)
        .map((node) => node.message)
        .filter(
            (m): m is NonNullable<(typeof parsed.mapping)[string]['message']> => !!m && m.author.role === 'assistant',
        )
        .sort((a, b) => (a.update_time ?? a.create_time ?? 0) - (b.update_time ?? b.create_time ?? 0));

    if (messages.length === 0) {
        return null;
    }

    const text = (messages[messages.length - 1].content.parts ?? [])
        .filter((p): p is string => typeof p === 'string')
        .join('');
    const normalized = text.trim();
    return normalized.length === 0 || /^v\d+$/i.test(normalized) ? null : normalized;
};

// Readiness checks

export const isCapturedConversationReady = (adapter: LLMPlatform, parsed: unknown): boolean => {
    if (!parsed || typeof parsed !== 'object' || !('conversation_id' in parsed)) {
        return false;
    }
    const conversation = parsed as Parameters<NonNullable<LLMPlatform['evaluateReadiness']>>[0];
    return adapter.evaluateReadiness
        ? adapter.evaluateReadiness(conversation).ready
        : isConversationReady(conversation);
};

// Proactive-fetch URL resolution

export const isFetchReady = (adapter: LLMPlatform): boolean =>
    !!adapter.extractConversationIdFromUrl && (!!adapter.buildApiUrl || !!adapter.buildApiUrls);

/**
 * Returns the deduplicated list of API URL candidates for a given adapter and
 * conversation ID, filtered to the current origin.
 */
export const getApiUrlCandidates = (adapter: LLMPlatform, conversationId: string): string[] => {
    const urls: string[] = [];
    for (const url of adapter.buildApiUrls?.(conversationId) ?? []) {
        if (typeof url === 'string' && url.length > 0 && !urls.includes(url)) {
            urls.push(url);
        }
    }
    const primary = adapter.buildApiUrl?.(conversationId);
    if (primary && !urls.includes(primary)) {
        urls.unshift(primary);
    }

    const origin = window.location.origin;
    return urls.filter((url) => {
        try {
            return new URL(url, origin).origin === origin;
        } catch {
            return false;
        }
    });
};
