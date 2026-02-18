export type FetchInterceptor = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function resolveRequestUrl(input: RequestInfo | URL) {
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
}

function resolveRequestMethod(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof init?.method === 'string' && init.method.length > 0) {
        return init.method;
    }
    if (input instanceof Request && typeof input.method === 'string' && input.method.length > 0) {
        return input.method;
    }
    return 'GET';
}

export function createFetchInterceptor(originalFetch: typeof fetch, interceptor: FetchInterceptor) {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
            return await interceptor(input, init);
        } catch (error) {
            const requestUrl = resolveRequestUrl(input);
            const requestMethod = resolveRequestMethod(input, init);
            console.error('fetch interceptor error', { requestUrl, requestMethod, error });
            return originalFetch(input, init);
        }
    }) as typeof fetch;
}
