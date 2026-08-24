import type { HeaderRecord } from '@/utils/proactive-fetch-headers';
import {
    MAX_EXPLICIT_EXPORT_RESPONSE_BYTES,
    readBoundedResponseBodyText,
} from '@/utils/bounded-response-body';

export const MAX_429_RETRIES = 3;
export const MAX_429_RETRY_DELAY_MS = 30_000;

export type FetchTextResult =
    | { ok: true; text: string }
    | {
          ok: false;
          status: number;
          message: string;
          kind?: undefined;
      }
    | {
          ok: false;
          kind: 'response_too_large';
          status: 0;
          message: string;
          maxBytes: number;
      };

export class BulkAuthContextRejectedError extends Error {
    readonly status: 401 | 403;

    constructor(status: 401 | 403) {
        super(`Bulk export stopped after HTTP ${status} authentication failure.`);
        this.name = 'BulkAuthContextRejectedError';
        this.status = status;
    }
}

export type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type FetchTextRequestInit = {
    method?: 'GET' | 'POST';
    headers?: HeadersInit;
    body?: BodyInit | null;
    signal?: AbortSignal;
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
    invalidateAuthContext?: (platformName: string) => void;
    authContextInvalidated?: boolean;
    authContextInvalidatedStatus?: 401 | 403;
    signal?: AbortSignal;
};

type WaitOutcome = 'completed' | 'deadline' | 'aborted';

const waitForDelay = async (
    context: FetchContext,
    requestedDelayMs: number,
    deadlineAt: number,
    signal: AbortSignal | undefined,
): Promise<WaitOutcome> => {
    if (signal?.aborted) {
        return 'aborted';
    }

    const remainingMs = deadlineAt - context.nowImpl();
    if (remainingMs <= 0) {
        return 'deadline';
    }

    const delayMs = Math.min(requestedDelayMs, remainingMs);
    return new Promise<WaitOutcome>((resolve, reject) => {
        let settled = false;
        const timerId = globalThis.setTimeout(() => {
            finish(delayMs < requestedDelayMs ? 'deadline' : 'completed');
        }, delayMs);

        const cleanup = () => {
            globalThis.clearTimeout(timerId);
            signal?.removeEventListener('abort', onAbort);
        };

        const finish = (outcome: WaitOutcome) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(outcome);
        };

        const fail = (error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };

        const onAbort = () => finish('aborted');
        signal?.addEventListener('abort', onAbort, { once: true });

        try {
            context.sleepImpl(delayMs).then(
                () => {
                    if (signal?.aborted) {
                        finish('aborted');
                    } else if (delayMs < requestedDelayMs || context.nowImpl() >= deadlineAt) {
                        finish('deadline');
                    } else {
                        finish('completed');
                    }
                },
                fail,
            );
        } catch (error) {
            fail(error);
        }
    });
};

const getRetryDelayMs = (response: Response, nowMs: number, attempt: number): number => {
    let delayMs: number;
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
        const asNumber = Number(retryAfter);
        if (Number.isFinite(asNumber) && asNumber > 0) {
            delayMs = asNumber * 1000;
            return Math.min(MAX_429_RETRY_DELAY_MS, delayMs);
        }
        const dateValue = Date.parse(retryAfter);
        if (Number.isFinite(dateValue)) {
            delayMs = Math.max(1_000, dateValue - nowMs);
            return Math.min(MAX_429_RETRY_DELAY_MS, delayMs);
        }
    }

    const reset = response.headers.get('x-rate-limit-reset');
    if (reset) {
        const resetEpochSeconds = Number(reset);
        if (Number.isFinite(resetEpochSeconds) && resetEpochSeconds > 0) {
            delayMs = Math.max(1_000, resetEpochSeconds * 1000 - nowMs + 500);
            return Math.min(MAX_429_RETRY_DELAY_MS, delayMs);
        }
    }

    return Math.min(MAX_429_RETRY_DELAY_MS, Math.max(1_000, 1_500 * 2 ** attempt));
};

const shouldRetryRateLimit = (response: Response, attempt: number) =>
    response.status === 429 && attempt < MAX_429_RETRIES;

const buildFailedFetchResult = (status: number, message: string): FetchTextResult => ({
    ok: false,
    status,
    message,
});

const waitForRequestSlot = async (
    context: FetchContext,
    deadlineAt: number,
    signal: AbortSignal | undefined,
): Promise<WaitOutcome> => {
    if (context.requestCount > 0 && typeof context.delayMs === 'number') {
        const outcome = await waitForDelay(context, context.delayMs, deadlineAt, signal);
        if (outcome !== 'completed') {
            return outcome;
        }
    }
    context.requestCount += 1;
    return 'completed';
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

const readResponseText = async (response: Response, signal: AbortSignal) => {
    if (signal.aborted) {
        throw new Error('Request timed out while reading response body.');
    }
    try {
        return await readBoundedResponseBodyText(response, {
            maxBytes: MAX_EXPLICIT_EXPORT_RESPONSE_BYTES,
            signal,
        });
    } catch (error) {
        if (signal.aborted) {
            throw new Error('Request timed out while reading response body.');
        }
        throw error;
    }
};

type AttemptOutcome = { result: FetchTextResult } | { retryDelayMs: number };

const processFetchResponse = async (
    response: Response,
    context: FetchContext,
    attempt: number,
    signal: AbortSignal,
): Promise<AttemptOutcome> => {
    if (response.status === 401 || response.status === 403) {
        context.authContextInvalidated = true;
        context.authContextInvalidatedStatus = response.status;
        try {
            context.invalidateAuthContext?.(context.platformName);
        } catch {
            // Context invalidation is defensive and must not mask the fetch result.
        }
    }
    if (response.status === 429 && attempt >= MAX_429_RETRIES) {
        return { result: buildFailedFetchResult(429, 'Rate limit retries exhausted') };
    }

    if (shouldRetryRateLimit(response, attempt)) {
        return { retryDelayMs: getRetryDelayMs(response, context.nowImpl(), attempt) };
    }

    if (!response.ok) {
        return { result: buildFailedFetchResult(response.status, response.statusText || 'Request failed') };
    }

    const body = await readResponseText(response, signal);
    if (body.kind === 'too_large') {
        return {
            result: {
                ok: false,
                kind: 'response_too_large',
                status: 0,
                message: `Response body exceeded ${MAX_EXPLICIT_EXPORT_RESPONSE_BYTES} bytes.`,
                maxBytes: MAX_EXPLICIT_EXPORT_RESPONSE_BYTES,
            },
        };
    }
    return { result: { ok: true, text: body.text } };
};

const executeFetchAttempt = async (
    url: string,
    context: FetchContext,
    init: FetchTextRequestInit | undefined,
    attempt: number,
    deadlineAt: number,
    externalSignal: AbortSignal | undefined,
): Promise<AttemptOutcome> => {
    const remainingMs = deadlineAt - context.nowImpl();
    if (remainingMs <= 0) {
        return { result: buildFailedFetchResult(0, 'Request deadline exceeded.') };
    }

    const controller = new AbortController();
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    const timeoutId = globalThis.setTimeout(() => controller.abort(), remainingMs);

    try {
        const response = await requestWithTimeout(url, context, init, controller.signal);
        return await processFetchResponse(response, context, attempt, controller.signal);
    } catch (error) {
        return { result: buildFailedFetchResult(0, error instanceof Error ? error.message : String(error)) };
    } finally {
        globalThis.clearTimeout(timeoutId);
        externalSignal?.removeEventListener('abort', abortFromExternal);
    }
};

const failureForWaitOutcome = (outcome: WaitOutcome, phase: 'slot' | 'retry'): FetchTextResult => {
    if (outcome === 'aborted') {
        return buildFailedFetchResult(
            0,
            phase === 'retry' ? 'Request aborted while waiting to retry.' : 'Request aborted while waiting for a request slot.',
        );
    }
    return buildFailedFetchResult(
        0,
        phase === 'retry' ? 'Request deadline exceeded while waiting to retry.' : 'Request deadline exceeded.',
    );
};

const throwIfAuthContextInvalidated = (context: FetchContext): void => {
    if (context.authContextInvalidated) {
        throw new BulkAuthContextRejectedError(context.authContextInvalidatedStatus ?? 401);
    }
};

export const fetchText = async (
    url: string,
    context: FetchContext,
    init?: FetchTextRequestInit,
): Promise<FetchTextResult> => {
    throwIfAuthContextInvalidated(context);

    const externalSignal = init?.signal ?? context.signal;
    const deadlineAt = context.nowImpl() + context.timeoutMs;
    let attempt = 0;

    while (attempt <= MAX_429_RETRIES) {
        const slotOutcome = await waitForRequestSlot(context, deadlineAt, externalSignal);
        if (slotOutcome !== 'completed') {
            return failureForWaitOutcome(slotOutcome, 'slot');
        }
        if (externalSignal?.aborted) {
            return buildFailedFetchResult(0, 'Request aborted.');
        }

        const outcome = await executeFetchAttempt(url, context, init, attempt, deadlineAt, externalSignal);
        if ('result' in outcome) {
            throwIfAuthContextInvalidated(context);
            return outcome.result;
        }

        const retryOutcome = await waitForDelay(context, outcome.retryDelayMs, deadlineAt, externalSignal);
        if (retryOutcome !== 'completed') {
            return failureForWaitOutcome(retryOutcome, 'retry');
        }
        attempt += 1;
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
