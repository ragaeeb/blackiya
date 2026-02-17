/**
 * Proactive fetch header utilities
 *
 * Extracts and sanitizes request headers from in-page ChatGPT requests so
 * follow-up conversation fetches can reuse auth/client context safely.
 */

export type HeaderRecord = Record<string, string>;

const FORBIDDEN_HEADER_NAMES = new Set([
    'cookie',
    'content-length',
    'host',
    'origin',
    'referer',
    'user-agent',
    'accept-encoding',
    'connection',
    'priority',
]);

function isForwardableHeader(name: string): boolean {
    const normalized = name.toLowerCase();
    if (FORBIDDEN_HEADER_NAMES.has(normalized)) {
        return false;
    }
    if (normalized.startsWith('sec-')) {
        return false;
    }
    return true;
}

function appendHeaders(target: Map<string, string>, headers: HeadersInit | undefined): void {
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
}

export function toForwardableHeaderRecord(headers: HeadersInit | undefined): HeaderRecord | undefined {
    const collected = new Map<string, string>();
    appendHeaders(collected, headers);

    const result: HeaderRecord = {};
    for (const [name, value] of collected.entries()) {
        if (!isForwardableHeader(name)) {
            continue;
        }
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            continue;
        }
        result[name] = trimmed;
    }

    return Object.keys(result).length > 0 ? result : undefined;
}

export function mergeHeaderRecords(base?: HeaderRecord, incoming?: HeaderRecord): HeaderRecord | undefined {
    if (!base && !incoming) {
        return undefined;
    }
    return {
        ...(base ?? {}),
        ...(incoming ?? {}),
    };
}

export function extractForwardableHeadersFromFetchArgs(args: Parameters<typeof fetch>): HeaderRecord | undefined {
    const merged = new Map<string, string>();
    if (args[0] instanceof Request) {
        appendHeaders(merged, args[0].headers);
    }
    appendHeaders(merged, args[1]?.headers);

    const result: HeaderRecord = {};
    for (const [name, value] of merged.entries()) {
        if (!isForwardableHeader(name)) {
            continue;
        }
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            continue;
        }
        result[name] = trimmed;
    }

    return Object.keys(result).length > 0 ? result : undefined;
}
