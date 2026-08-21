import type { HeaderRecord } from '@/utils/proactive-fetch-headers';

export const MAX_429_RETRIES = 3;

export type FetchTextResult =
    | { ok: true; text: string }
    | {
          ok: false;
          status: number;
          message: string;
      };

export type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type FetchTextRequestInit = {
    method?: 'GET' | 'POST';
    headers?: HeadersInit;
    body?: BodyInit | null;
};

export type FetchContext = {
    fetchImpl: FetchImplementation;
    sleepImpl: (milliseconds: number) => Promise<void>;
    nowImpl: () => number;
    authHeaders: HeaderRecord | undefined;
    timeoutMs: number;
    delayMs?: number;
    platformName: string;
    requestCount: number;
};

const getRetryDelayMs = (response: Response, nowMs: number, attempt: number): number => {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
        const asNumber = Number(retryAfter);
        if (Number.isFinite(asNumber) && asNumber > 0) {
            return asNumber * 1000;
        }
        const dateValue = Date.parse(retryAfter);
        if (Number.isFinite(dateValue)) {
            return Math.max(1_000, dateValue - nowMs);
        }
    }

    const reset = response.headers.get('x-rate-limit-reset');
    if (reset) {
        const resetEpochSeconds = Number(reset);
        if (Number.isFinite(resetEpochSeconds) && resetEpochSeconds > 0) {
            return Math.max(1_000, resetEpochSeconds * 1000 - nowMs + 500);
        }
    }

    return Math.max(1_000, Math.min(30_000, 1_500 * 2 ** attempt));
};

const shouldRetryRateLimit = (response: Response, attempt: number) =>
    response.status === 429 && attempt < MAX_429_RETRIES;

const buildFailedFetchResult = (status: number, message: string): FetchTextResult => ({
    ok: false,
    status,
    message,
});

const waitForRequestSlot = async (context: FetchContext) => {
    if (context.requestCount > 0 && typeof context.delayMs === 'number') {
        await context.sleepImpl(context.delayMs);
    }
    context.requestCount += 1;
};

const requestWithTimeout = async (
    url: string,
    context: FetchContext,
    init: FetchTextRequestInit | undefined,
    signal: AbortSignal,
) =>
    context.fetchImpl.call(globalThis, url, {
        method: init?.method ?? 'GET',
        credentials: 'include',
        headers: init?.headers ?? context.authHeaders,
        body: init?.body ?? null,
        signal,
    });

const processFetchResponse = async (
    response: Response,
    context: FetchContext,
    attempt: number,
): Promise<{ result?: FetchTextResult; retryDelayMs?: number }> => {
    if (response.status === 429 && attempt >= MAX_429_RETRIES) {
        return { result: buildFailedFetchResult(429, 'Rate limit retries exhausted') };
    }

    if (shouldRetryRateLimit(response, attempt)) {
        return { retryDelayMs: getRetryDelayMs(response, context.nowImpl(), attempt) };
    }

    if (!response.ok) {
        return { result: buildFailedFetchResult(response.status, response.statusText || 'Request failed') };
    }

    return {
        result: {
            ok: true,
            text: await response.text(),
        },
    };
};

export const fetchText = async (
    url: string,
    context: FetchContext,
    init?: FetchTextRequestInit,
): Promise<FetchTextResult> => {
    let attempt = 0;

    while (attempt <= MAX_429_RETRIES) {
        await waitForRequestSlot(context);
        const controller = new AbortController();
        const timeoutId = globalThis.setTimeout(() => controller.abort(), context.timeoutMs);

        try {
            const response = await requestWithTimeout(url, context, init, controller.signal);
            const outcome = await processFetchResponse(response, context, attempt);
            if (typeof outcome.retryDelayMs === 'number') {
                const retryDelayMs = outcome.retryDelayMs;
                await context.sleepImpl(retryDelayMs);
                attempt += 1;
                continue;
            }
            return outcome.result ?? buildFailedFetchResult(0, 'Unknown request failure');
        } catch (error) {
            return buildFailedFetchResult(0, error instanceof Error ? error.message : String(error));
        } finally {
            globalThis.clearTimeout(timeoutId);
        }
    }

    return buildFailedFetchResult(429, 'Rate limit retries exhausted');
};

export const fetchFirstSuccessfulResponse = async (
    urls: string[],
    context: FetchContext,
): Promise<FetchTextResult | null> => {
    let lastFailure: FetchTextResult | null = null;
    for (const url of urls) {
        const response = await fetchText(url, context);
        if (response.ok) {
            return response;
        }
        lastFailure = response;
    }
    return lastFailure;
};
