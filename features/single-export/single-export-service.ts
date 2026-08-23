/**
 * v3 single-export (on-demand Save JSON) kernel.
 *
 * Resolves the platform adapter and conversation id only when invoked,
 * fetches the canonical detail endpoint, validates the response is
 * terminal, and triggers an injected JSON download. Returns a typed
 * fail-fast result for every failure path.
 *
 * Invariants:
 *  - One deterministic candidate sequence per call, no retries, no warm
 *    fetch, no snapshot replay, no stabilization.
 *  - ChatGPT may advance through its adapter-provided candidates only after a
 *    deterministic 404; timeouts and other failures fail fast.
 *  - The hard timeout covers both response headers and body consumption.
 *  - `conversation_id` in the response must equal the id from the URL.
 *  - `evaluateReadiness.terminal` must be true or the export is rejected.
 *  - The complete `mapping` tree is preserved verbatim.
 *
 * @module features/single-export/single-export-service
 */

import type { LLMPlatform, PlatformReadiness } from '@/platforms/types';
import { logger as defaultLogger } from '@/utils/logger';
import type { ConversationData } from '@/utils/types';
import { buildDetailRequest, type DetailRequest, resolvePlatformKind } from './endpoint-resolver';
import {
    normalizeSingleExportTimeout,
    SINGLE_EXPORT_DEFAULT_TIMEOUT_MS,
    type SingleExportDeps,
    type SingleExportError,
    type SingleExportLogger,
    type SingleExportResult,
} from './types';

const noopLogger: SingleExportLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
};

const isAbortError = (err: unknown): boolean =>
    err instanceof DOMException ? err.name === 'AbortError' : err instanceof Error && err.name === 'AbortError';

const safeLogger = (deps: SingleExportDeps): SingleExportLogger => deps.logger ?? defaultLogger ?? noopLogger;

const failure = (error: SingleExportError): SingleExportResult => ({ kind: 'failure', error });

const hasAuthorizationHeader = (headers: Record<string, string> | undefined): boolean =>
    Object.entries(headers ?? {}).some(
        ([name, value]) =>
            name.toLowerCase() === 'authorization' && typeof value === 'string' && value.trim().length > 0,
    );

const notifyAuthFailure = (deps: SingleExportDeps, platformName: string): void => {
    try {
        deps.invalidateAuthContext?.(platformName);
    } catch {
        // Request-context invalidation is defensive and must not mask the typed export failure.
    }
};

const extractConversationId = (adapter: LLMPlatform, pageUrl: string): string | null => {
    try {
        return adapter.extractConversationId(pageUrl) ?? null;
    } catch {
        return null;
    }
};

const resolveReadiness = (adapter: LLMPlatform, data: ConversationData): PlatformReadiness => {
    if (typeof adapter.evaluateReadiness === 'function') {
        return adapter.evaluateReadiness(data);
    }
    // Adapters without a readiness evaluator are treated as terminal by
    // convention: the response is what the server gave us, so we trust it.
    return { ready: true, terminal: true, reason: 'no-evaluator', contentHash: null, latestAssistantTextLength: 0 };
};

type ResolvedRequest = {
    adapter: LLMPlatform;
    conversationId: string;
    requests: DetailRequest[];
    authHeaders?: Record<string, string>;
};

type ResolvedContext = {
    adapter: LLMPlatform;
    conversationId: string;
    pageUrl: string;
    platformKind: Exclude<ReturnType<typeof resolvePlatformKind>, 'unsupported'>;
};

const resolveContext = (
    deps: SingleExportDeps,
): { ok: true; context: ResolvedContext } | { ok: false; result: SingleExportResult } => {
    const pageUrl = deps.getPageUrl();
    const adapter = deps.resolveAdapter(pageUrl);
    const platformKind = resolvePlatformKind(adapter, pageUrl);

    if (platformKind === 'unsupported' || !adapter) {
        return {
            ok: false,
            result: failure({ kind: 'unsupported_platform', platformName: adapter?.name ?? null }),
        };
    }

    const conversationId = extractConversationId(adapter, pageUrl);
    if (!conversationId) {
        return { ok: false, result: failure({ kind: 'missing_conversation_id', pageUrl }) };
    }

    return { ok: true, context: { adapter, conversationId, pageUrl, platformKind } };
};

const resolveRequest = (
    deps: SingleExportDeps,
    context: ResolvedContext,
): { ok: true; resolved: ResolvedRequest } | { ok: false; result: SingleExportResult } => {
    const { adapter, conversationId, pageUrl, platformKind } = context;

    const detail = buildDetailRequest({
        platform: platformKind,
        adapter,
        conversationId,
        pageUrl,
        geminiContext: deps.getGeminiBatchexecuteContext?.(),
    });
    if (!detail.ok) {
        if (detail.reason === 'missing_auth') {
            return { ok: false, result: failure({ kind: 'missing_auth', platformName: adapter.name }) };
        }
        return { ok: false, result: failure({ kind: 'missing_endpoint', platformName: adapter.name }) };
    }

    const authHeaders = deps.getAuthHeaders?.();
    const authSnapshot = authHeaders ? { ...authHeaders } : undefined;
    if (platformKind === 'chatgpt' && !hasAuthorizationHeader(authSnapshot)) {
        return { ok: false, result: failure({ kind: 'missing_auth', platformName: adapter.name }) };
    }

    return {
        ok: true,
        resolved: {
            adapter,
            conversationId,
            requests: detail.requests,
            authHeaders: authSnapshot,
        },
    };
};

type FetchOutcome =
    | { ok: true; response: Response; request: DetailRequest; body: string }
    | { ok: false; result: SingleExportResult };

const REQUEST_TIMEOUT = Symbol('single-export-request-timeout');
const DETERMINISTIC_FALLBACK_STATUS = 404;

type CandidateOutcome =
    | { kind: 'response'; response: Response; body: string }
    | { kind: 'fallback'; response: Response }
    | { kind: 'failure'; result: SingleExportResult };

type TimeoutGuard = {
    controller: AbortController;
    timeoutPromise: Promise<never>;
    hasTimedOut: () => boolean;
    dispose: () => void;
};

const createTimeoutGuard = (timeoutMs: number): TimeoutGuard => {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    let timeoutGuardRejectId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
        const rejectId = setTimeout(() => reject(REQUEST_TIMEOUT), timeoutMs);
        timeoutGuardRejectId = rejectId;
    });
    return {
        controller,
        timeoutPromise,
        hasTimedOut: () => timedOut,
        dispose: () => {
            clearTimeout(timeoutId);
            clearTimeout(timeoutGuardRejectId);
        },
    };
};

const readBodyWithTimeout = async (
    response: Response,
    timeoutPromise: Promise<never>,
): Promise<{ body: string; timedOut: boolean }> => {
    try {
        return { body: await Promise.race([response.text(), timeoutPromise]), timedOut: false };
    } catch (error) {
        return { body: '', timedOut: error === REQUEST_TIMEOUT };
    }
};

const cancelResponseBody = async (response: Response): Promise<void> => {
    try {
        await response.body?.cancel();
    } catch {
        // A failed cleanup must not hide the deterministic fallback.
    }
};

const isTimeoutError = (error: unknown, timeoutGuard: TimeoutGuard): boolean =>
    error === REQUEST_TIMEOUT || timeoutGuard.hasTimedOut() || isAbortError(error);

type CandidateFetchOutcome = { ok: true; response: Response } | { ok: false; result: SingleExportResult };

const executeCandidateFetch = async (
    resolved: ResolvedRequest,
    request: DetailRequest,
    headers: Record<string, string>,
    timeoutGuard: TimeoutGuard,
    fetchImpl: typeof fetch,
    timeoutMs: number,
): Promise<CandidateFetchOutcome> => {
    try {
        const response = await Promise.race([
            fetchImpl(request.url, {
                method: request.method,
                credentials: 'include',
                headers,
                body: request.body ?? null,
                signal: timeoutGuard.controller.signal,
            }),
            timeoutGuard.timeoutPromise,
        ]);
        return { ok: true, response };
    } catch (err) {
        if (err === REQUEST_TIMEOUT || timeoutGuard.hasTimedOut() || isAbortError(err)) {
            return {
                ok: false,
                result: failure({ kind: 'timeout', platformName: resolved.adapter.name, timeoutMs }),
            };
        }
        return {
            ok: false,
            result: failure({
                kind: 'http_failure',
                platformName: resolved.adapter.name,
                status: 0,
                statusText: err instanceof Error ? err.message : 'Network error',
            }),
        };
    }
};

const fetchCandidate = async (
    resolved: ResolvedRequest,
    request: DetailRequest,
    deps: SingleExportDeps,
    timeoutMs: number,
): Promise<CandidateOutcome> => {
    const fetchImpl: typeof fetch = deps.fetchImpl ?? globalThis.fetch;
    const timeoutGuard = createTimeoutGuard(timeoutMs);
    const headers: Record<string, string> = {
        ...(resolved.authHeaders ?? {}),
        ...(request.headers ?? {}),
    };

    try {
        const fetched = await executeCandidateFetch(resolved, request, headers, timeoutGuard, fetchImpl, timeoutMs);
        if (!fetched.ok) {
            return { kind: 'failure', result: fetched.result };
        }
        const { response } = fetched;

        if (response.status === DETERMINISTIC_FALLBACK_STATUS) {
            await cancelResponseBody(response);
            return { kind: 'fallback', response };
        }

        if (!response.ok) {
            return { kind: 'response', response, body: '' };
        }

        const bodyResult = await readBodyWithTimeout(response, timeoutGuard.timeoutPromise);
        const bodyTimedOut = bodyResult.timedOut || timeoutGuard.hasTimedOut();
        if (bodyTimedOut) {
            return {
                kind: 'failure',
                result: failure({ kind: 'timeout', platformName: resolved.adapter.name, timeoutMs }),
            };
        }
        return { kind: 'response', response, body: bodyResult.body };
    } catch (err) {
        if (isTimeoutError(err, timeoutGuard)) {
            return {
                kind: 'failure',
                result: failure({ kind: 'timeout', platformName: resolved.adapter.name, timeoutMs }),
            };
        }
        return {
            kind: 'failure',
            result: failure({
                kind: 'http_failure',
                platformName: resolved.adapter.name,
                status: 0,
                statusText: err instanceof Error ? err.message : 'Network error',
            }),
        };
    } finally {
        timeoutGuard.dispose();
        timeoutGuard.controller.abort();
    }
};

const dispatchRequest = async (
    resolved: ResolvedRequest,
    deps: SingleExportDeps,
    timeoutMs: number,
): Promise<FetchOutcome> => {
    const now = deps.now ?? Date.now;
    const startedAt = now();
    const deadline = startedAt + timeoutMs;

    for (const [index, request] of resolved.requests.entries()) {
        const remainingMs = Math.max(1, deadline - now());
        const outcome = await fetchCandidate(resolved, request, deps, remainingMs);
        if (outcome.kind === 'fallback' && index < resolved.requests.length - 1) {
            continue;
        }
        if (outcome.kind === 'failure') {
            return { ok: false, result: outcome.result };
        }
        if (outcome.kind === 'fallback') {
            return { ok: true, response: outcome.response, request, body: '' };
        }
        return { ok: true, response: outcome.response, request, body: outcome.body };
    }

    return {
        ok: false,
        result: failure({
            kind: 'http_failure',
            platformName: resolved.adapter.name,
            status: 404,
            statusText: 'Not Found',
        }),
    };
};

const classifyHttpResponse = (
    resolved: ResolvedRequest,
    response: Response,
): { ok: true } | { ok: false; result: SingleExportResult } => {
    if (response.status === 401 || response.status === 403) {
        return { ok: false, result: failure({ kind: 'missing_auth', platformName: resolved.adapter.name }) };
    }
    if (!response.ok) {
        return {
            ok: false,
            result: failure({
                kind: 'http_failure',
                platformName: resolved.adapter.name,
                status: response.status,
                statusText: response.statusText || 'Request failed',
            }),
        };
    }
    return { ok: true };
};

type ParsedResponse = {
    adapter: LLMPlatform;
    conversationId: string;
    data: ConversationData;
};

const validateConversation = (
    adapter: LLMPlatform,
    conversationId: string,
    data: ConversationData,
): { ok: true; parsed: ParsedResponse } | { ok: false; result: SingleExportResult } => {
    if (data.conversation_id !== conversationId) {
        return {
            ok: false,
            result: failure({
                kind: 'id_mismatch',
                platformName: adapter.name,
                expected: conversationId,
                actual: typeof data.conversation_id === 'string' ? data.conversation_id : null,
            }),
        };
    }

    const readiness = resolveReadiness(adapter, data);
    if (!readiness.ready || !readiness.terminal) {
        return {
            ok: false,
            result: failure({
                kind: 'not_terminal',
                platformName: adapter.name,
                reason: readiness.reason,
            }),
        };
    }

    return { ok: true, parsed: { adapter, conversationId, data } };
};

const parseAndValidate = (
    resolved: ResolvedRequest,
    request: DetailRequest,
    body: string,
): { ok: true; parsed: ParsedResponse } | { ok: false; result: SingleExportResult } => {
    if (!body) {
        return {
            ok: false,
            result: failure({
                kind: 'parse_failure',
                platformName: resolved.adapter.name,
                reason: 'empty response body',
            }),
        };
    }

    let parsed: ConversationData | null = null;
    try {
        parsed = resolved.adapter.parseInterceptedData(body, request.url);
    } catch (err) {
        return {
            ok: false,
            result: failure({
                kind: 'parse_failure',
                platformName: resolved.adapter.name,
                reason: err instanceof Error ? err.message : 'parser threw',
            }),
        };
    }
    if (!parsed) {
        return {
            ok: false,
            result: failure({
                kind: 'parse_failure',
                platformName: resolved.adapter.name,
                reason: 'parser returned null',
            }),
        };
    }

    return validateConversation(resolved.adapter, resolved.conversationId, parsed);
};

const deliverDownload = (
    parsed: ParsedResponse,
    deps: SingleExportDeps,
): { ok: true; filename: string; jsonString: string } | { ok: false; result: SingleExportResult } => {
    const jsonString = JSON.stringify(parsed.data, null, 2);
    const filename = parsed.adapter.formatFilename(parsed.data);
    try {
        deps.downloadJson(jsonString, filename);
        return { ok: true, filename, jsonString };
    } catch (err) {
        return {
            ok: false,
            result: failure({
                kind: 'download_failure',
                platformName: parsed.adapter.name,
                reason: err instanceof Error ? err.message : 'Download injection failed',
            }),
        };
    }
};

const deliverSuccess = (parsed: ParsedResponse, deps: SingleExportDeps): SingleExportResult => {
    const deliver = deliverDownload(parsed, deps);
    if (!deliver.ok) {
        return deliver.result;
    }
    return {
        kind: 'success',
        platformName: parsed.adapter.name,
        data: parsed.data,
        filename: deliver.filename,
        jsonString: deliver.jsonString,
    };
};

const tryCachedExport = (
    context: ResolvedContext,
    deps: SingleExportDeps,
    log: SingleExportLogger,
): SingleExportResult | null => {
    const cached = deps.getCachedConversation?.(context.adapter.name, context.conversationId);
    if (!cached) {
        return null;
    }
    const cachedOutcome = validateConversation(context.adapter, context.conversationId, cached);
    if (!cachedOutcome.ok) {
        log.debug('[Blackiya/v3] Save JSON: cached response was not eligible; falling back to detail request', {
            platform: context.adapter.name,
            conversationId: context.conversationId,
        });
        return null;
    }
    const result = deliverSuccess(cachedOutcome.parsed, deps);
    if (result.kind === 'success') {
        log.info('[Blackiya/v3] Save JSON: success from observed response cache', {
            platform: context.adapter.name,
            conversationId: context.conversationId,
            mappingNodes: Object.keys(cached.mapping).length,
        });
    }
    return result;
};

/**
 * Perform an on-demand single-conversation export.
 *
 * Resolves the platform and conversation id at call time (NOT at module
 * load), fetches a single deterministic detail URL, validates the response,
 * and invokes the injected download. Returns a discriminated result.
 *
 * The call is fail-fast: any deviation from the happy path is reported as a
 * typed error, never thrown to the caller.
 */
export const performSingleExport = async (
    timeoutMs: number | undefined,
    deps: SingleExportDeps,
): Promise<SingleExportResult> => {
    const log = safeLogger(deps);
    const normalizedTimeout = normalizeSingleExportTimeout(timeoutMs, SINGLE_EXPORT_DEFAULT_TIMEOUT_MS);

    const resolvedContext = resolveContext(deps);
    if (!resolvedContext.ok) {
        log.error('[Blackiya/v3] Save JSON: resolution failed', {
            kind: resolvedContext.result.kind === 'failure' ? resolvedContext.result.error.kind : 'unknown',
        });
        return resolvedContext.result;
    }
    const { context } = resolvedContext;

    const cachedResult = tryCachedExport(context, deps, log);
    if (cachedResult) {
        return cachedResult;
    }

    const resolvedReq = resolveRequest(deps, context);
    if (!resolvedReq.ok) {
        log.error('[Blackiya/v3] Save JSON: detail resolution failed', {
            kind: resolvedReq.result.kind === 'failure' ? resolvedReq.result.error.kind : 'unknown',
        });
        return resolvedReq.result;
    }
    const { resolved } = resolvedReq;

    const fetchOutcome = await dispatchRequest(resolved, deps, normalizedTimeout);
    if (!fetchOutcome.ok) {
        log.error('[Blackiya/v3] Save JSON: fetch failed', {
            platform: resolved.adapter.name,
            conversationId: resolved.conversationId,
        });
        return fetchOutcome.result;
    }

    const httpClass = classifyHttpResponse(resolved, fetchOutcome.response);
    if (!httpClass.ok) {
        if (fetchOutcome.response.status === 401 || fetchOutcome.response.status === 403) {
            notifyAuthFailure(deps, resolved.adapter.name);
        }
        log.error('[Blackiya/v3] Save JSON: HTTP classification failed', {
            platform: resolved.adapter.name,
            conversationId: resolved.conversationId,
        });
        return httpClass.result;
    }

    const parsedOutcome = parseAndValidate(resolved, fetchOutcome.request, fetchOutcome.body);
    if (!parsedOutcome.ok) {
        log.error('[Blackiya/v3] Save JSON: parse/validate failed', {
            platform: resolved.adapter.name,
            conversationId: resolved.conversationId,
        });
        return parsedOutcome.result;
    }

    const result = deliverSuccess(parsedOutcome.parsed, deps);
    if (result.kind === 'failure') {
        log.error('[Blackiya/v3] Save JSON: download failed', {
            platform: resolved.adapter.name,
            conversationId: resolved.conversationId,
        });
        return result;
    }

    log.info('[Blackiya/v3] Save JSON: success', {
        platform: parsedOutcome.parsed.adapter.name,
        conversationId: parsedOutcome.parsed.conversationId,
        mappingNodes: Object.keys(parsedOutcome.parsed.data.mapping).length,
    });
    return result;
};
