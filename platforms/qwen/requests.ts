import {
    QWEN_CONVERSATION_ID_PATTERN,
    QWEN_DETAIL_HISTORY_LIMIT,
    QWEN_HOST,
    QWEN_ORIGIN,
    QWEN_REQUEST_CONTEXT_HEADER_NAMES,
} from './constants';

const QWEN_DETAIL_PATH_PREFIX = '/api/v2/chats/';
const QWEN_LIST_PATH = '/api/v2/chats/';
const QWEN_COMPLETION_PATH = '/api/v2/chat/completions';
const QWEN_REQUIRED_CONTEXT_HEADER = 'bx-umidtoken';

export type QwenRequestContext = {
    headers: Record<string, string>;
};

export type QwenGetRequest = {
    url: string;
    method: 'GET';
    credentials: 'include';
    headers: Record<string, string>;
};

export type QwenPostRequest = {
    url: string;
    method: 'POST';
    credentials: 'include';
    headers: Record<string, string>;
    body: string;
};

export type QwenConversationListOptions = {
    page?: number;
    excludeProject?: boolean;
};

const normalizeHeaders = (headers: HeadersInit): Map<string, string> => {
    const result = new Map<string, string>();
    const append = (name: string, value: string) => {
        const normalizedName = name.toLowerCase();
        if (
            !QWEN_REQUEST_CONTEXT_HEADER_NAMES.includes(
                normalizedName as (typeof QWEN_REQUEST_CONTEXT_HEADER_NAMES)[number],
            )
        ) {
            return;
        }
        const normalizedValue = value.trim();
        if (normalizedValue.length > 0) {
            result.set(normalizedName, normalizedValue);
        }
    };

    if (headers instanceof Headers) {
        headers.forEach((value, name) => {
            append(name, value);
        });
        return result;
    }
    if (Array.isArray(headers)) {
        for (const [name, value] of headers) {
            append(String(name), String(value));
        }
        return result;
    }
    for (const [name, value] of Object.entries(headers)) {
        append(name, String(value));
    }
    return result;
};

const copyContextHeaders = (context: QwenRequestContext): Record<string, string> => ({ ...context.headers });

export const extractQwenRequestContext = (headers: HeadersInit): QwenRequestContext | null => {
    const normalized = normalizeHeaders(headers);
    if (!normalized.has(QWEN_REQUIRED_CONTEXT_HEADER)) {
        return null;
    }
    return { headers: Object.fromEntries(normalized) };
};

export const buildQwenConversationDetailUrl = (conversationId: string): string | null => {
    if (!QWEN_CONVERSATION_ID_PATTERN.test(conversationId)) {
        return null;
    }
    const url = new URL(`${QWEN_DETAIL_PATH_PREFIX}${conversationId}`, QWEN_ORIGIN);
    url.searchParams.set('direction', 'up');
    url.searchParams.set('limit', `${QWEN_DETAIL_HISTORY_LIMIT}`);
    return url.href;
};

export const extractQwenConversationIdFromDetailUrl = (url: string): string | null => {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.hostname !== QWEN_HOST) {
            return null;
        }
        const match = parsed.pathname.match(/^\/api\/v2\/chats\/([^/]+)$/);
        const conversationId = match?.[1] ?? null;
        return conversationId && QWEN_CONVERSATION_ID_PATTERN.test(conversationId) ? conversationId : null;
    } catch {
        return null;
    }
};

const hasCanonicalDetailQuery = (url: URL): boolean => {
    return (
        url.searchParams.size === 2 &&
        url.searchParams.getAll('direction').length === 1 &&
        url.searchParams.get('direction') === 'up' &&
        url.searchParams.getAll('limit').length === 1 &&
        url.searchParams.get('limit') === `${QWEN_DETAIL_HISTORY_LIMIT}`
    );
};

export const isQwenConversationDetailRequest = (url: string, method: string): boolean => {
    if (method.toUpperCase() !== 'GET' || !extractQwenConversationIdFromDetailUrl(url)) {
        return false;
    }
    try {
        const parsed = new URL(url);
        return parsed.hash.length === 0 && hasCanonicalDetailQuery(parsed);
    } catch {
        return false;
    }
};

export const buildQwenConversationDetailRequest = (
    conversationId: string,
    context: QwenRequestContext,
): QwenGetRequest | null => {
    const url = buildQwenConversationDetailUrl(conversationId);
    if (!url || !context.headers[QWEN_REQUIRED_CONTEXT_HEADER]) {
        return null;
    }
    return { url, method: 'GET', credentials: 'include', headers: copyContextHeaders(context) };
};

export const buildQwenConversationListUrl = (options: QwenConversationListOptions = {}): string => {
    const page =
        typeof options.page === 'number' && Number.isFinite(options.page) ? Math.max(1, Math.floor(options.page)) : 1;
    const url = new URL(QWEN_LIST_PATH, QWEN_ORIGIN);
    url.searchParams.set('page', `${page}`);
    url.searchParams.set('exclude_project', `${options.excludeProject ?? true}`);
    return url.href;
};

export const buildQwenConversationListRequest = (
    options: QwenConversationListOptions,
    context: QwenRequestContext,
): QwenGetRequest | null => {
    if (!context.headers[QWEN_REQUIRED_CONTEXT_HEADER]) {
        return null;
    }
    return {
        url: buildQwenConversationListUrl(options),
        method: 'GET',
        credentials: 'include',
        headers: copyContextHeaders(context),
    };
};

export const isQwenCompletionEndpoint = (url: string, method: string): boolean => {
    if (method.toUpperCase() !== 'POST') {
        return false;
    }
    try {
        const parsed = new URL(url);
        return (
            parsed.protocol === 'https:' && parsed.hostname === QWEN_HOST && parsed.pathname === QWEN_COMPLETION_PATH
        );
    } catch {
        return false;
    }
};

export const buildQwenCompletionRequest = (input: {
    conversationId: string;
    body: unknown;
    context: QwenRequestContext;
}): QwenPostRequest | null => {
    if (!QWEN_CONVERSATION_ID_PATTERN.test(input.conversationId)) {
        return null;
    }
    if (!input.context.headers[QWEN_REQUIRED_CONTEXT_HEADER]) {
        return null;
    }
    let body: string;
    try {
        const serialized = JSON.stringify(input.body);
        if (typeof serialized !== 'string') {
            return null;
        }
        body = serialized;
    } catch {
        return null;
    }
    const url = new URL(QWEN_COMPLETION_PATH, QWEN_ORIGIN);
    url.searchParams.set('chat_id', input.conversationId);
    return {
        url: url.href,
        method: 'POST',
        credentials: 'include',
        headers: { ...copyContextHeaders(input.context), 'content-type': 'application/json' },
        body,
    };
};
