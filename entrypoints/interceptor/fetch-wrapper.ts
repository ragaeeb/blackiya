export type FetchInterceptor = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const FETCH_INTERCEPTOR_LOG_TTL_MS = 10_000;
const FETCH_INTERCEPTOR_MAX_ERROR_LOG_ENTRIES = 256;
const fetchInterceptorErrorLogTimestamps = new Map<string, number>();

export type FetchInterceptorOptions = Readonly<{
    now?: () => number;
    errorLogTtlMs?: number;
    maxErrorLogEntries?: number;
}>;

const resolveRequestUrl = (input: RequestInfo | URL) => {
    if (typeof input === 'string') {
        return input;
    }
    if (input instanceof URL) {
        return input.toString();
    }
    if (typeof (input as Request)?.url === 'string') {
        return (input as Request).url;
    }
    return '[unknown-url]';
};

const sanitizeRequestUrl = (requestUrl: string) => {
    try {
        const parsed = new URL(requestUrl, 'https://blackiya.invalid');
        return parsed.pathname || '/';
    } catch {
        return requestUrl.split(/[?#]/, 1)[0] || '[unknown-path]';
    }
};

const resolvePositiveInteger = (value: number | undefined, fallback: number) => {
    if (value === undefined || !Number.isFinite(value) || value < 1) {
        return fallback;
    }
    return Math.floor(value);
};

const pruneExpiredErrorLogEntries = (now: number, ttlMs: number) => {
    for (const [key, timestamp] of fetchInterceptorErrorLogTimestamps) {
        if (now - timestamp >= ttlMs) {
            fetchInterceptorErrorLogTimestamps.delete(key);
        }
    }
};

const evictOldestErrorLogEntries = (maxEntries: number) => {
    while (fetchInterceptorErrorLogTimestamps.size >= maxEntries) {
        const oldestKey = fetchInterceptorErrorLogTimestamps.keys().next().value;
        if (oldestKey === undefined) {
            return;
        }
        fetchInterceptorErrorLogTimestamps.delete(oldestKey);
    }
};

const resolveRequestMethod = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.method === 'string' && init.method.length > 0) {
        return init.method;
    }
    if (input instanceof Request && typeof input.method === 'string' && input.method.length > 0) {
        return input.method;
    }
    return 'GET';
};

export const createFetchInterceptor = (
    originalFetch: typeof fetch,
    interceptor: FetchInterceptor,
    options: FetchInterceptorOptions = {},
) => {
    const now = options.now ?? Date.now;
    const errorLogTtlMs = resolvePositiveInteger(options.errorLogTtlMs, FETCH_INTERCEPTOR_LOG_TTL_MS);
    const maxErrorLogEntries = resolvePositiveInteger(
        options.maxErrorLogEntries,
        FETCH_INTERCEPTOR_MAX_ERROR_LOG_ENTRIES,
    );

    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
            return await interceptor(input, init);
        } catch (error) {
            const requestUrl = sanitizeRequestUrl(resolveRequestUrl(input));
            const requestMethod = resolveRequestMethod(input, init);
            const key = `${requestMethod}:${requestUrl}`;
            const timestamp = now();
            pruneExpiredErrorLogEntries(timestamp, errorLogTtlMs);
            if (!fetchInterceptorErrorLogTimestamps.has(key)) {
                evictOldestErrorLogEntries(maxErrorLogEntries);
                fetchInterceptorErrorLogTimestamps.set(key, timestamp);
                console.debug('fetch interceptor fallback', {
                    requestUrl,
                    requestMethod,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            return originalFetch(input, init);
        }
    }) as typeof fetch;
};
