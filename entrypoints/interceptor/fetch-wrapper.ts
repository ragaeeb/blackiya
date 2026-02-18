export type FetchInterceptor = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createFetchInterceptor(originalFetch: typeof fetch, interceptor: FetchInterceptor): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
            return await interceptor(input, init);
        } catch {
            return originalFetch(input, init);
        }
    }) as typeof fetch;
}
