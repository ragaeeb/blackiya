const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com';
const DEEPSEEK_HISTORY_PATH = '/api/v0/chat/history_messages';

export const DEEPSEEK_CONVERSATION_ID_PATTERN =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

const DEEPSEEK_CLIENT_HEADER_NAMES = [
    'authorization',
    'x-client-bundle-id',
    'x-client-locale',
    'x-client-platform',
    'x-client-timezone-offset',
    'x-client-version',
] as const;

type DeepSeekClientHeaderName = (typeof DEEPSEEK_CLIENT_HEADER_NAMES)[number];

export type DeepSeekHistoryRequestContext = {
    conversationId: string;
    cacheVersion?: string;
    cacheResetAt?: string;
    headers: Partial<Record<DeepSeekClientHeaderName, string>>;
};

export type DeepSeekHistoryRequest = {
    url: string;
    method: 'GET';
    headers: Partial<Record<DeepSeekClientHeaderName, string>>;
    credentials: 'include';
};

const readAllowlistedHeaders = (headers: HeadersInit | undefined) => {
    const result: Partial<Record<DeepSeekClientHeaderName, string>> = {};
    if (!headers) {
        return result;
    }

    let normalized: Headers;
    try {
        normalized = new Headers(headers);
    } catch {
        return result;
    }

    for (const name of DEEPSEEK_CLIENT_HEADER_NAMES) {
        const value = normalized.get(name)?.trim();
        if (value) {
            result[name] = value;
        }
    }
    return result;
};

const parseDeepSeekHistoryUrl = (url: string): URL | null => {
    try {
        const parsed = new URL(url);
        if (
            parsed.origin !== DEEPSEEK_ORIGIN ||
            parsed.pathname !== DEEPSEEK_HISTORY_PATH ||
            parsed.username.length > 0 ||
            parsed.password.length > 0 ||
            parsed.hash.length > 0
        ) {
            return null;
        }
        const allowedNames = new Set(['chat_session_id', 'cache_version', 'cache_reset_at']);
        for (const name of parsed.searchParams.keys()) {
            if (!allowedNames.has(name)) {
                return null;
            }
        }
        if (parsed.searchParams.getAll('chat_session_id').length !== 1) {
            return null;
        }
        for (const optionalName of ['cache_version', 'cache_reset_at']) {
            const values = parsed.searchParams.getAll(optionalName);
            if (values.length > 1 || (values.length === 1 && values[0]!.trim().length === 0)) {
                return null;
            }
        }
        return parsed;
    } catch {
        return null;
    }
};

export const parseDeepSeekHistoryRequestContext = (
    url: string,
    headers?: HeadersInit,
): DeepSeekHistoryRequestContext | null => {
    const parsed = parseDeepSeekHistoryUrl(url);
    if (!parsed) {
        return null;
    }

    const conversationId = parsed.searchParams.get('chat_session_id');
    if (!conversationId || !DEEPSEEK_CONVERSATION_ID_PATTERN.test(conversationId)) {
        return null;
    }

    const cacheVersion = parsed.searchParams.get('cache_version')?.trim() || undefined;
    const cacheResetAt = parsed.searchParams.get('cache_reset_at')?.trim() || undefined;
    return {
        conversationId,
        ...(cacheVersion ? { cacheVersion } : {}),
        ...(cacheResetAt ? { cacheResetAt } : {}),
        headers: readAllowlistedHeaders(headers),
    };
};

export const buildDeepSeekHistoryRequest = (
    conversationId: string,
    context?: DeepSeekHistoryRequestContext,
): DeepSeekHistoryRequest | null => {
    if (!DEEPSEEK_CONVERSATION_ID_PATTERN.test(conversationId)) {
        return null;
    }
    if (context && context.conversationId !== conversationId) {
        return null;
    }

    const url = new URL(DEEPSEEK_HISTORY_PATH, DEEPSEEK_ORIGIN);
    url.searchParams.set('chat_session_id', conversationId);
    if (context?.cacheVersion) {
        url.searchParams.set('cache_version', context.cacheVersion);
    }
    if (context?.cacheResetAt) {
        url.searchParams.set('cache_reset_at', context.cacheResetAt);
    }

    return {
        url: url.toString(),
        method: 'GET',
        headers: readAllowlistedHeaders(context?.headers),
        credentials: 'include',
    };
};
