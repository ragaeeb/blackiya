/**
 * Proactive fetch header utilities
 *
 * Extracts and sanitizes request headers from in-page ChatGPT requests so
 * follow-up conversation fetches can reuse auth/client context safely.
 */

export type HeaderRecord = Record<string, string>;

export type SupportedPlatformName =
    | 'ChatGPT'
    | 'Gemini'
    | 'Grok'
    | 'Claude'
    | 'DeepSeek'
    | 'Qwen'
    | 'Z.ai'
    | 'Meta Muse'
    | 'Amazon Nova';

const FORWARDABLE_HEADERS_BY_PLATFORM: Record<SupportedPlatformName, ReadonlySet<string>> = {
    ChatGPT: new Set([
        'authorization',
        'oai-client-version',
        'oai-client-build-number',
        'oai-device-id',
        'oai-language',
    ]),
    Gemini: new Set(['authorization', 'x-goog-authuser', 'x-goog-visitor-id']),
    Grok: new Set([
        'authorization',
        'x-csrf-token',
        'x-twitter-active-user',
        'x-twitter-auth-type',
        'x-twitter-client-language',
    ]),
    Claude: new Set(),
    DeepSeek: new Set([
        'x-client-bundle-id',
        'x-client-locale',
        'x-client-platform',
        'x-client-timezone-offset',
        'x-client-version',
    ]),
    Qwen: new Set(['bx-umidtoken', 'bx-ua', 'bx-v', 'source', 'timezone', 'version']),
    'Z.ai': new Set(['x-region']),
    'Meta Muse': new Set(),
    'Amazon Nova': new Set(),
};

const appendHeaders = (target: Map<string, string>, headers: HeadersInit | undefined) => {
    if (!headers) {
        return;
    }

    if (headers instanceof Headers) {
        headers.forEach((value, key) => {
            target.set(key.toLowerCase(), value);
        });
        return;
    }

    if (Array.isArray(headers)) {
        for (const [key, value] of headers) {
            target.set(String(key).toLowerCase(), String(value));
        }
        return;
    }

    for (const [key, value] of Object.entries(headers)) {
        target.set(key.toLowerCase(), String(value));
    }
};

const filterHeaders = (
    collected: Map<string, string>,
    platform: SupportedPlatformName | undefined,
): HeaderRecord | undefined => {
    const allowedHeaders = platform ? FORWARDABLE_HEADERS_BY_PLATFORM[platform] : undefined;
    if (!allowedHeaders) {
        return undefined;
    }

    const result: HeaderRecord = {};
    for (const [name, value] of collected.entries()) {
        if (!allowedHeaders.has(name)) {
            continue;
        }
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            continue;
        }
        result[name] = trimmed;
    }

    return Object.keys(result).length > 0 ? result : undefined;
};

export const toForwardableHeaderRecord = (
    headers: HeadersInit | undefined,
    platform?: SupportedPlatformName,
): HeaderRecord | undefined => {
    const collected = new Map<string, string>();
    appendHeaders(collected, headers);
    return filterHeaders(collected, platform);
};

export const mergeHeaderRecords = (base?: HeaderRecord, incoming?: HeaderRecord): HeaderRecord | undefined => {
    if (!base && !incoming) {
        return undefined;
    }
    return {
        ...(base ?? {}),
        ...(incoming ?? {}),
    };
};

export const extractForwardableHeadersFromFetchArgs = (
    args: Parameters<typeof fetch>,
    platform?: SupportedPlatformName,
): HeaderRecord | undefined => {
    const merged = new Map<string, string>();
    if (args[0] instanceof Request) {
        appendHeaders(merged, args[0].headers);
    }
    appendHeaders(merged, args[1]?.headers);
    return filterHeaders(merged, platform);
};
