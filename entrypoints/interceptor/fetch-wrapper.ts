export type FetchInterceptor = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const FETCH_INTERCEPTOR_LOG_TTL_MS = 10_000;
const fetchInterceptorErrorLogTimestamps = new Map<string, number>();

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

const resolveRequestMethod = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.method === 'string' && init.method.length > 0) {
        return init.method;
    }
    if (input instanceof Request && typeof input.method === 'string' && input.method.length > 0) {
        return input.method;
    }
    return 'GET';
};

export const createFetchInterceptor = (originalFetch: typeof fetch, interceptor: FetchInterceptor) => {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
            return await interceptor(input, init);
        } catch (error) {
            const requestUrl = resolveRequestUrl(input);
            const requestMethod = resolveRequestMethod(input, init);
            const key = `${requestMethod}:${requestUrl}`;
            const now = Date.now();
            const previous = fetchInterceptorErrorLogTimestamps.get(key) ?? 0;
            if (now - previous >= FETCH_INTERCEPTOR_LOG_TTL_MS) {
                fetchInterceptorErrorLogTimestamps.set(key, now);
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
