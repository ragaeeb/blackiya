import { GEMINI_RPC_IDS } from '@/platforms/constants';
import { geminiState } from '@/platforms/gemini/state';
import type { LLMPlatform } from '@/platforms/types';
import { downloadAsJSON } from '@/utils/download';
import type { GeminiBatchexecuteContext } from '@/utils/gemini-batchexecute-bridge';
import { parseBatchexecuteResponse } from '@/utils/google-rpc';
import { logger } from '@/utils/logger';
import { clearPlatformHeadersCache } from '@/utils/platform-header-cache';
import type { HeaderRecord } from '@/utils/proactive-fetch-headers';
import type {
    BulkExportChatsMessage,
    BulkExportChatsSuccessResponse,
    BulkExportProgressMessage,
} from '@/utils/runner/bulk-chat-export-contract';
import { BULK_EXPORT_PROGRESS_MESSAGE } from '@/utils/runner/bulk-chat-export-contract';
import { attachExportMeta } from '@/utils/runner/export-helpers';
import { applyResolvedExportTitle } from '@/utils/runner/export-pipeline';
import type { ConversationData } from '@/utils/types';

const CHATGPT_HOSTS = ['chatgpt.com', 'chat.openai.com'];
const CHATGPT_CONVERSATION_ID_PATTERN = /^[a-f0-9-]{8,}$/i;
const GROK_COM_CONVERSATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const GEMINI_CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,}$/;
const DEFAULT_DELAY_MS = 1_200;
const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_DELAY_MS = 250;
const MAX_DELAY_MS = 20_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_429_RETRIES = 3;
const GEMINI_BATCHEXECUTE_PATH = '/_/BardChatUi/data/batchexecute';

type BulkChatExportDeps = {
    getAdapter: () => LLMPlatform | null;
    getAuthHeaders: () => HeaderRecord | undefined;
    getGeminiBatchexecuteContext?: () => GeminiBatchexecuteContext | undefined;
    fetchImpl?: typeof fetch;
    downloadImpl?: (payload: unknown, filename: string) => void;
    sleepImpl?: (milliseconds: number) => Promise<void>;
    nowImpl?: () => number;
    locationHref?: () => string;
    onProgress?: (message: BulkExportProgressMessage) => void;
};

type NormalizedOptions = {
    maxItems: number | null;
    delayMs: number;
    timeoutMs: number;
};

type RequestContext = {
    options: NormalizedOptions;
    adapter: LLMPlatform;
    fetchImpl: typeof fetch;
    downloadImpl: (payload: unknown, filename: string) => void;
    sleepImpl: (milliseconds: number) => Promise<void>;
    nowImpl: () => number;
    authHeaders: HeaderRecord | undefined;
    geminiBatchexecuteContext: GeminiBatchexecuteContext | undefined;
    requestCount: number;
    locationHref: () => string;
};

type ConversationListResult = {
    ids: string[];
    warnings: string[];
};

type PlatformKind = 'chatgpt' | 'gemini' | 'grok-com' | 'unsupported';

type FetchTextResult =
    | { ok: true; text: string }
    | {
          ok: false;
          status: number;
          message: string;
      };

const sleep = (milliseconds: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));

const normalizePositiveInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
    if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(value)));
};

const normalizeMaxItems = (value: number | undefined): number | null => {
    if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
        return 100;
    }
    if (value <= 0) {
        return null;
    }
    return Math.floor(value);
};

const normalizeOptions = (message: BulkExportChatsMessage): NormalizedOptions => ({
    maxItems: normalizeMaxItems(message.limit),
    delayMs: normalizePositiveInt(message.delayMs, DEFAULT_DELAY_MS, MIN_DELAY_MS, MAX_DELAY_MS),
    timeoutMs: normalizePositiveInt(message.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
});

const uniqueStrings = (values: string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        if (typeof value !== 'string') {
            continue;
        }
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) {
            continue;
        }
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
};

const parseJsonSafe = (text: string): unknown | null => {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const readString = (record: Record<string, unknown> | null, key: string): string | null => {
    if (!record) {
        return null;
    }
    const value = record[key];
    return typeof value === 'string' ? value : null;
};

const readNestedString = (
    record: Record<string, unknown> | null,
    containerKey: string,
    nestedKey: string,
): string | null => readString(asRecord(record?.[containerKey]), nestedKey);

const firstNonNull = <T>(values: Array<T | null>): T | null => {
    for (const value of values) {
        if (value !== null) {
            return value;
        }
    }
    return null;
};

const resolveHostFromLocation = (locationHref: string, fallbackHost: string) => {
    try {
        const host = new URL(locationHref).hostname;
        return host.length > 0 ? host : fallbackHost;
    } catch {
        return fallbackHost;
    }
};

const extractChatGptConversationIdFromItem = (item: unknown): string | null => {
    const record = asRecord(item);
    const candidate = firstNonNull([
        readString(record, 'id'),
        readString(record, 'conversation_id'),
        readNestedString(record, 'conversation', 'id'),
    ]);
    if (!candidate || !CHATGPT_CONVERSATION_ID_PATTERN.test(candidate)) {
        return null;
    }
    return candidate;
};

const collectChatGptConversationArrays = (payload: unknown): unknown[][] => {
    const record = asRecord(payload);
    if (!record) {
        return [];
    }

    const dataRecord = asRecord(record.data);
    const nestedPayloadRecord = asRecord(record.payload);
    const candidates = [
        record.items,
        record.conversations,
        dataRecord?.items,
        dataRecord?.conversations,
        nestedPayloadRecord?.items,
        nestedPayloadRecord?.conversations,
    ];
    return candidates.filter((value): value is unknown[] => Array.isArray(value));
};

const extractChatGptConversationIdsFromPayload = (payload: unknown): string[] => {
    const ids: string[] = [];
    for (const items of collectChatGptConversationArrays(payload)) {
        for (const item of items) {
            const conversationId = extractChatGptConversationIdFromItem(item);
            if (conversationId) {
                ids.push(conversationId);
            }
        }
    }

    return uniqueStrings(ids);
};

const extractChatGptConversationIdsFromText = (text: string): string[] => {
    const ids: string[] = [];
    const idPatterns = [
        /"id"\s*:\s*"([a-z0-9-]{8,})"/gi,
        /"conversation_id"\s*:\s*"([a-z0-9-]{8,})"/gi,
        /"conversation"\s*:\s*\{\s*"id"\s*:\s*"([a-z0-9-]{8,})"/gi,
    ];

    for (const pattern of idPatterns) {
        for (const match of text.matchAll(pattern)) {
            const candidate = match[1];
            if (typeof candidate === 'string' && CHATGPT_CONVERSATION_ID_PATTERN.test(candidate)) {
                ids.push(candidate);
            }
        }
    }

    return uniqueStrings(ids);
};

const collectGrokComConversationArrays = (payload: unknown): unknown[][] => {
    const record = asRecord(payload);
    if (!record) {
        return [];
    }

    const dataRecord = asRecord(record.data);
    const candidates = [record.items, record.conversations, dataRecord?.items, dataRecord?.conversations];
    return candidates.filter((value): value is unknown[] => Array.isArray(value));
};

const extractGrokComConversationIdFromItem = (item: unknown): string | null => {
    const record = asRecord(item);
    const candidate = firstNonNull([
        readString(record, 'id'),
        readString(record, 'conversationId'),
        readString(record, 'conversation_id'),
        readString(record, 'rest_id'),
        readNestedString(record, 'conversation', 'id'),
        readNestedString(record, 'grokConversation', 'rest_id'),
    ]);
    if (!candidate || !GROK_COM_CONVERSATION_ID_PATTERN.test(candidate)) {
        return null;
    }
    return candidate;
};

const extractGrokComConversationIdsFromPayload = (payload: unknown): string[] => {
    const ids: string[] = [];
    for (const collection of collectGrokComConversationArrays(payload)) {
        for (const item of collection) {
            const conversationId = extractGrokComConversationIdFromItem(item);
            if (conversationId) {
                ids.push(conversationId);
            }
        }
    }
    return uniqueStrings(ids);
};

const extractGrokComConversationIdsFromText = (text: string): string[] => {
    const ids: string[] = [];
    const keyPatterns = [
        /"conversationId"\s*:\s*"([a-f0-9-]{36})"/gi,
        /"conversation_id"\s*:\s*"([a-f0-9-]{36})"/gi,
        /"id"\s*:\s*"([a-f0-9-]{36})"/gi,
        /"conversation"\s*:\s*\{\s*"id"\s*:\s*"([a-f0-9-]{36})"/gi,
    ];
    for (const pattern of keyPatterns) {
        for (const match of text.matchAll(pattern)) {
            const candidate = match[1];
            if (typeof candidate === 'string' && GROK_COM_CONVERSATION_ID_PATTERN.test(candidate)) {
                ids.push(candidate);
            }
        }
    }
    return uniqueStrings(ids);
};

const extractGrokResponseIdsFromNodePayload = (payload: unknown): string[] => {
    const ids: string[] = [];
    const pushId = (value: unknown) => {
        if (typeof value !== 'string') {
            return;
        }
        if (GROK_COM_CONVERSATION_ID_PATTERN.test(value)) {
            ids.push(value);
        }
    };

    const readIdsFromNodeArray = (value: unknown) => {
        if (!Array.isArray(value)) {
            return;
        }
        for (const item of value) {
            const itemRecord = asRecord(item);
            pushId(itemRecord?.responseId);
        }
    };

    const record = asRecord(payload);
    readIdsFromNodeArray(record?.responseNodes);
    readIdsFromNodeArray(record?.inflightResponses);

    return uniqueStrings(ids);
};

const extractGrokResponseIdsFromNodeText = (text: string): string[] => {
    const parsed = parseJsonSafe(text);
    const fromPayload = extractGrokResponseIdsFromNodePayload(parsed);
    if (fromPayload.length > 0) {
        return fromPayload;
    }

    const ids: string[] = [];
    const pattern = /"responseId"\s*:\s*"([a-f0-9-]{36})"/gi;
    for (const match of text.matchAll(pattern)) {
        const candidate = match[1];
        if (typeof candidate === 'string' && GROK_COM_CONVERSATION_ID_PATTERN.test(candidate)) {
            ids.push(candidate);
        }
    }
    return uniqueStrings(ids);
};

const extractGeminiConversationIdsFromBatchexecuteText = (text: string): string[] => {
    const ids: string[] = [];

    const addMatches = (source: string) => {
        const matcher = /\bc_([a-zA-Z0-9_-]{8,})\b/g;
        for (const match of source.matchAll(matcher)) {
            const conversationId = match[1];
            if (GEMINI_CONVERSATION_ID_PATTERN.test(conversationId)) {
                ids.push(conversationId);
            }
        }
    };

    addMatches(text);
    const rpcResults = parseBatchexecuteResponse(text);
    for (const rpc of rpcResults) {
        if (typeof rpc.payload !== 'string') {
            continue;
        }
        addMatches(rpc.payload);
    }

    return uniqueStrings(ids);
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

const waitForRequestSlot = async (context: RequestContext) => {
    if (context.requestCount === 0) {
        context.requestCount += 1;
        return;
    }
    await context.sleepImpl(context.options.delayMs);
    context.requestCount += 1;
};

type FetchTextRequestInit = {
    method?: 'GET' | 'POST';
    headers?: HeadersInit;
    body?: BodyInit | null;
};

const requestWithTimeout = async (
    url: string,
    context: RequestContext,
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

const shouldRetryRateLimit = (response: Response, attempt: number) =>
    response.status === 429 && attempt < MAX_429_RETRIES;

const buildFailedFetchResult = (status: number, message: string): FetchTextResult => ({
    ok: false,
    status,
    message,
});

const processFetchResponse = async (
    response: Response,
    context: RequestContext,
    attempt: number,
): Promise<{ result?: FetchTextResult; retryDelayMs?: number }> => {
    if (shouldRetryRateLimit(response, attempt)) {
        return { retryDelayMs: getRetryDelayMs(response, context.nowImpl(), attempt) };
    }

    if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
            void clearPlatformHeadersCache(context.adapter.name);
        }
        return { result: buildFailedFetchResult(response.status, response.statusText || 'Request failed') };
    }

    return {
        result: {
            ok: true,
            text: await response.text(),
        },
    };
};

const fetchText = async (
    url: string,
    context: RequestContext,
    init?: FetchTextRequestInit,
): Promise<FetchTextResult> => {
    let attempt = 0;

    while (attempt <= MAX_429_RETRIES) {
        await waitForRequestSlot(context);
        const controller = new AbortController();
        const timeoutId = globalThis.setTimeout(() => controller.abort(), context.options.timeoutMs);

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

const resolvePlatformKind = (adapter: LLMPlatform, locationHref: string): PlatformKind => {
    if (adapter.name === 'ChatGPT') {
        return 'chatgpt';
    }
    if (adapter.name === 'Gemini') {
        return 'gemini';
    }
    if (adapter.name !== 'Grok') {
        return 'unsupported';
    }

    try {
        const { hostname } = new URL(locationHref);
        if (hostname === 'grok.com') {
            return 'grok-com';
        }
    } catch {
        return 'unsupported';
    }

    return 'unsupported';
};

const buildChatGptListUrls = (host: string, offset: number, pageSize: number) => [
    `https://${host}/backend-api/conversations?offset=${offset}&limit=${pageSize}&order=updated&is_archived=false&is_starred=false`,
    `https://${host}/backend-api/conversations?offset=${offset}&limit=${pageSize}&order=updated&is_archived=false`,
    `https://${host}/backend-api/conversations?offset=${offset}&limit=${pageSize}&order=updated`,
];

const fetchFirstSuccessfulResponse = async (
    urls: string[],
    context: RequestContext,
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

const parseChatGptListPageIds = (responseText: string): string[] => {
    const parsedPayload = parseJsonSafe(responseText);
    const fromPayload = extractChatGptConversationIdsFromPayload(parsedPayload);
    return fromPayload.length > 0 ? fromPayload : extractChatGptConversationIdsFromText(responseText);
};

const listConversationIdsChatGpt = async (context: RequestContext): Promise<ConversationListResult> => {
    const limit = context.options.maxItems;
    const ids: string[] = [];
    const warnings: string[] = [];
    let offset = 0;
    const pageSize = 100;

    while (limit === null || ids.length < limit) {
        const currentHost = resolveHostFromLocation(context.locationHref(), CHATGPT_HOSTS[0]);
        const host = CHATGPT_HOSTS.includes(currentHost) ? currentHost : CHATGPT_HOSTS[0];
        const response = await fetchFirstSuccessfulResponse(buildChatGptListUrls(host, offset, pageSize), context);

        if (!response?.ok) {
            warnings.push(
                `ChatGPT list endpoint failed at offset=${offset}: status=${response?.status ?? 0} message=${response?.message ?? 'Unknown error'}`,
            );
            break;
        }

        const pageIds = parseChatGptListPageIds(response.text);
        if (pageIds.length === 0) {
            warnings.push(`ChatGPT list endpoint returned no parseable conversation ids at offset=${offset}.`);
            break;
        }

        ids.push(...pageIds);
        offset += pageSize;
        if (pageIds.length < pageSize) {
            break;
        }
    }

    return {
        ids: uniqueStrings(limit === null ? ids : ids.slice(0, limit)),
        warnings,
    };
};

const resolveGrokComNextCursor = (payload: unknown): string | null => {
    const record = asRecord(payload);
    const cursor = firstNonNull([
        readString(record, 'nextCursor'),
        readString(record, 'next_cursor'),
        readString(record, 'cursor'),
    ]);
    return cursor && cursor.length > 0 ? cursor : null;
};

const fetchGrokComConversationPage = async (cursor: string | null, context: RequestContext) => {
    const pageSize = 100;
    const cursorPart = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const url = `https://grok.com/rest/app-chat/conversations?pageSize=${pageSize}${cursorPart}`;
    const response = await fetchText(url, context);
    if (!response.ok) {
        return {
            ids: [],
            nextCursor: null,
            warning: `Grok list endpoint failed: status=${response.status} message=${response.message || 'Unknown error'}`,
        };
    }
    const parsed = parseJsonSafe(response.text);
    const idsFromPayload = extractGrokComConversationIdsFromPayload(parsed);
    const ids = idsFromPayload.length > 0 ? idsFromPayload : extractGrokComConversationIdsFromText(response.text);
    return {
        ids,
        nextCursor: resolveGrokComNextCursor(parsed),
        warning:
            ids.length === 0
                ? `Grok list endpoint returned no parseable conversation ids (cursor=${cursor ?? 'initial'}).`
                : undefined,
    };
};

const listConversationIdsGrokCom = async (context: RequestContext): Promise<ConversationListResult> => {
    const limit = context.options.maxItems;
    const ids: string[] = [];
    const warnings: string[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    while (limit === null || ids.length < limit) {
        const page = await fetchGrokComConversationPage(cursor, context);
        if (!page) {
            break;
        }
        if (page.warning) {
            warnings.push(page.warning);
        }
        if (page.ids.length === 0) {
            break;
        }

        ids.push(...page.ids);
        if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
            break;
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
    }

    return {
        ids: uniqueStrings(limit === null ? ids : ids.slice(0, limit)),
        warnings,
    };
};

const listConversationIdsGemini = async (context: RequestContext): Promise<ConversationListResult> => {
    const warnings: string[] = [];
    const host = resolveHostFromLocation(context.locationHref(), 'gemini.google.com');
    const locationConversationId = context.adapter.extractConversationId(context.locationHref());
    const sourcePath = locationConversationId ? `/app/${locationConversationId}` : '/app';
    const cachedIds = uniqueStrings([
        ...Array.from(geminiState.conversationTitles.keys()),
        ...(locationConversationId ? [locationConversationId] : []),
    ]);
    const url = `https://${host}${GEMINI_BATCHEXECUTE_PATH}?rpcids=${GEMINI_RPC_IDS.TITLES}&source-path=${encodeURIComponent(sourcePath)}&rt=c`;
    const response = await fetchText(url, context);
    if (!response.ok) {
        warnings.push(
            `Gemini titles list request failed: status=${response.status} message=${response.message || 'Unknown error'}`,
        );
        if (cachedIds.length > 0) {
            warnings.push(
                `Gemini titles request failed; falling back to cached Gemini title ids (${cachedIds.length}).`,
            );
            return {
                ids: context.options.maxItems === null ? cachedIds : cachedIds.slice(0, context.options.maxItems),
                warnings,
            };
        }
        return { ids: [], warnings };
    }

    const parsedIds = extractGeminiConversationIdsFromBatchexecuteText(response.text);
    if (parsedIds.length > 0) {
        return {
            ids: context.options.maxItems === null ? parsedIds : parsedIds.slice(0, context.options.maxItems),
            warnings,
        };
    }

    if (cachedIds.length > 0) {
        warnings.push(
            `Gemini titles endpoint returned no ids; falling back to cached Gemini title ids (${cachedIds.length}).`,
        );
    }

    const ids = cachedIds;
    return {
        ids: context.options.maxItems === null ? ids : ids.slice(0, context.options.maxItems),
        warnings,
    };
};

const uniqueUrls = (urls: string[]): string[] => {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const candidate of urls) {
        if (typeof candidate !== 'string') {
            continue;
        }
        const url = candidate.trim();
        if (!url || seen.has(url)) {
            continue;
        }
        seen.add(url);
        result.push(url);
    }
    return result;
};

const buildDetailUrls = (
    platform: PlatformKind,
    adapter: LLMPlatform,
    conversationId: string,
    host: string,
): string[] => {
    if (platform === 'chatgpt') {
        const fromAdapter = adapter.buildApiUrls?.(conversationId) ?? [];
        const primary = adapter.buildApiUrl?.(conversationId);
        const fallback = [`https://${host}/backend-api/conversation/${conversationId}`];
        return uniqueUrls([...(primary ? [primary] : []), ...fromAdapter, ...fallback]);
    }

    if (platform === 'gemini') {
        return uniqueUrls([
            `https://${host}${GEMINI_BATCHEXECUTE_PATH}?rpcids=${GEMINI_RPC_IDS.CONVERSATION}&source-path=${encodeURIComponent(`/app/${conversationId}`)}&rt=c`,
            `https://${host}${GEMINI_BATCHEXECUTE_PATH}?rpcids=${GEMINI_RPC_IDS.CONVERSATION}&source-path=${encodeURIComponent('/app')}&rt=c&conversation_id=${encodeURIComponent(conversationId)}`,
        ]);
    }

    if (platform === 'grok-com') {
        const fromAdapter = adapter.buildApiUrls?.(conversationId) ?? [];
        return uniqueUrls(
            fromAdapter.length > 0
                ? fromAdapter
                : [
                      `https://grok.com/rest/app-chat/conversations_v2/${conversationId}?includeWorkspaces=true&includeTaskResult=true`,
                      `https://grok.com/rest/app-chat/conversations/${conversationId}/response-node?includeThreads=true`,
                  ],
        );
    }

    return [];
};

const ensureUniqueFilename = (filename: string, used: Set<string>) => {
    const base = filename.trim() || 'conversation_export';
    if (!used.has(base)) {
        used.add(base);
        return base;
    }

    let suffix = 2;
    while (used.has(`${base}_${suffix}`)) {
        suffix += 1;
    }

    const next = `${base}_${suffix}`;
    used.add(next);
    return next;
};

const buildGeminiConversationPostBody = (conversationId: string, at: string) => {
    const payload = JSON.stringify([
        [
            [
                GEMINI_RPC_IDS.CONVERSATION,
                JSON.stringify([`c_${conversationId}`, 10, null, 1, [1], [4], null, 1]),
                null,
                'generic',
            ],
        ],
    ]);
    const params = new URLSearchParams();
    params.set('f.req', payload);
    params.set('at', at);
    return `${params.toString()}&`;
};

const buildGeminiConversationPostUrl = (host: string, conversationId: string, context: GeminiBatchexecuteContext) => {
    const params = new URLSearchParams();
    params.set('rpcids', GEMINI_RPC_IDS.CONVERSATION);
    params.set('source-path', `/app/${conversationId}`);
    if (context.bl) {
        params.set('bl', context.bl);
    }
    if (context.fSid) {
        params.set('f.sid', context.fSid);
    }
    if (context.hl) {
        params.set('hl', context.hl);
    }
    const reqid = Number.isFinite(context.reqid)
        ? Math.max(0, Math.floor(context.reqid as number)) + 1
        : Date.now() % 10_000_000;
    params.set('_reqid', `${reqid}`);
    params.set('rt', context.rt ?? 'c');
    return `https://${host}${GEMINI_BATCHEXECUTE_PATH}?${params.toString()}`;
};

const fetchGeminiConversationByPost = async (
    conversationId: string,
    context: RequestContext,
): Promise<ConversationData | null> => {
    const geminiContext = context.geminiBatchexecuteContext;
    if (!geminiContext?.at) {
        return null;
    }

    const host = resolveHostFromLocation(context.locationHref(), 'gemini.google.com');
    const url = buildGeminiConversationPostUrl(host, conversationId, geminiContext);
    const headers = {
        ...(context.authHeaders ?? {}),
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    };
    const response = await fetchText(url, context, {
        method: 'POST',
        headers,
        body: buildGeminiConversationPostBody(conversationId, geminiContext.at),
    });
    if (!response.ok) {
        logger.debug('Bulk export Gemini detail POST failed', { conversationId, status: response.status });
        return null;
    }

    return context.adapter.parseInterceptedData(response.text, url);
};

const fetchConversationById = async (
    conversationId: string,
    platform: PlatformKind,
    context: RequestContext,
): Promise<ConversationData | null> => {
    if (platform === 'gemini') {
        const fromPost = await fetchGeminiConversationByPost(conversationId, context);
        if (fromPost) {
            return fromPost;
        }
    }

    const detailResult = await fetchConversationFromDetailUrls(conversationId, platform, context);
    if (detailResult.conversation) {
        return detailResult.conversation;
    }
    if (platform !== 'grok-com') {
        return null;
    }
    return fetchGrokReconnectConversation(conversationId, detailResult.reconnectResponseIds, context);
};

type DetailFetchResult = {
    conversation: ConversationData | null;
    reconnectResponseIds: string[];
};

const fetchConversationFromDetailUrls = async (
    conversationId: string,
    platform: PlatformKind,
    context: RequestContext,
): Promise<DetailFetchResult> => {
    const host = resolveHostFromLocation(context.locationHref(), 'chatgpt.com');
    const urls = buildDetailUrls(platform, context.adapter, conversationId, host);
    const reconnectResponseIds: string[] = [];

    for (const url of urls) {
        const response = await fetchText(url, context);
        if (!response.ok) {
            if (response.status !== 404) {
                logger.debug('Bulk export detail fetch failed', { conversationId, url, status: response.status });
            }
            continue;
        }

        if (platform === 'grok-com' && url.includes('/response-node')) {
            reconnectResponseIds.push(...extractGrokResponseIdsFromNodeText(response.text));
        }

        const parsed = context.adapter.parseInterceptedData(response.text, url);
        if (parsed) {
            return { conversation: parsed, reconnectResponseIds };
        }
    }

    return { conversation: null, reconnectResponseIds };
};

const fetchGrokReconnectConversation = async (
    conversationId: string,
    reconnectResponseIds: string[],
    context: RequestContext,
): Promise<ConversationData | null> => {
    for (const responseId of uniqueStrings(reconnectResponseIds)) {
        const reconnectUrl = `https://grok.com/rest/app-chat/conversations/reconnect-response-v2/${responseId}`;
        const reconnectResponse = await fetchText(reconnectUrl, context);
        if (!reconnectResponse.ok) {
            if (reconnectResponse.status !== 404) {
                logger.debug('Bulk export reconnect fetch failed', {
                    conversationId,
                    responseId,
                    status: reconnectResponse.status,
                });
            }
            continue;
        }

        const parsed = context.adapter.parseInterceptedData(reconnectResponse.text, reconnectUrl);
        if (parsed) {
            return parsed;
        }
    }
    return null;
};

const listConversationIds = async (
    platform: PlatformKind,
    context: RequestContext,
): Promise<ConversationListResult> => {
    if (platform === 'chatgpt') {
        return listConversationIdsChatGpt(context);
    }
    if (platform === 'gemini') {
        return listConversationIdsGemini(context);
    }
    if (platform === 'grok-com') {
        return listConversationIdsGrokCom(context);
    }
    return { ids: [], warnings: [] };
};

export const runBulkChatExport = async (
    message: BulkExportChatsMessage,
    deps: BulkChatExportDeps,
): Promise<BulkExportChatsSuccessResponse['result']> => {
    const adapter = deps.getAdapter();
    if (!adapter) {
        throw new Error('No supported platform found for this tab.');
    }

    const locationHref = deps.locationHref ?? (() => window.location.href);
    const platformKind = resolvePlatformKind(adapter, locationHref());
    if (platformKind === 'unsupported') {
        throw new Error(`Bulk export is not supported for ${adapter.name} on this page yet.`);
    }

    const options = normalizeOptions(message);
    const context: RequestContext = {
        options,
        adapter,
        fetchImpl: deps.fetchImpl ?? fetch,
        downloadImpl: deps.downloadImpl ?? downloadAsJSON,
        sleepImpl: deps.sleepImpl ?? sleep,
        nowImpl: deps.nowImpl ?? Date.now,
        authHeaders: deps.getAuthHeaders(),
        geminiBatchexecuteContext: deps.getGeminiBatchexecuteContext?.(),
        requestCount: 0,
        locationHref,
    };

    const startedAt = context.nowImpl();
    const listResult = await listConversationIds(platformKind, context);
    const ids = listResult.ids;
    const warnings: string[] = [...listResult.warnings];
    deps.onProgress?.({
        type: BULK_EXPORT_PROGRESS_MESSAGE,
        stage: 'started',
        platform: adapter.name,
        discovered: ids.length,
        attempted: 0,
        exported: 0,
        failed: 0,
        remaining: ids.length,
    });
    if (ids.length === 0) {
        warnings.push('No conversations discovered from list endpoint.');
    }

    let attempted = 0;
    let exported = 0;
    let failed = 0;
    const usedFilenames = new Set<string>();

    for (const conversationId of ids) {
        attempted += 1;
        const conversation = await fetchConversationById(conversationId, platformKind, context);
        if (!conversation) {
            failed += 1;
            deps.onProgress?.({
                type: BULK_EXPORT_PROGRESS_MESSAGE,
                stage: 'progress',
                platform: adapter.name,
                discovered: ids.length,
                attempted,
                exported,
                failed,
                remaining: Math.max(0, ids.length - attempted),
            });
            continue;
        }

        applyResolvedExportTitle(conversation);
        const payload = attachExportMeta(conversation, {
            captureSource: 'canonical_api',
            fidelity: 'high',
            completeness: 'complete',
        });
        const filename = ensureUniqueFilename(adapter.formatFilename(conversation), usedFilenames);
        context.downloadImpl(payload, filename);
        exported += 1;
        deps.onProgress?.({
            type: BULK_EXPORT_PROGRESS_MESSAGE,
            stage: 'progress',
            platform: adapter.name,
            discovered: ids.length,
            attempted,
            exported,
            failed,
            remaining: Math.max(0, ids.length - attempted),
        });
    }

    const result = {
        platform: adapter.name,
        discovered: ids.length,
        attempted,
        exported,
        failed,
        elapsedMs: context.nowImpl() - startedAt,
        limit: options.maxItems ?? 0,
        warnings,
    };
    deps.onProgress?.({
        type: BULK_EXPORT_PROGRESS_MESSAGE,
        stage: 'completed',
        platform: adapter.name,
        discovered: result.discovered,
        attempted: result.attempted,
        exported: result.exported,
        failed: result.failed,
        remaining: 0,
    });
    return result;
};

export const __testables__ = {
    extractChatGptConversationIdsFromPayload,
    extractChatGptConversationIdsFromText,
    extractGrokComConversationIdsFromPayload,
    extractGrokComConversationIdsFromText,
    extractGrokResponseIdsFromNodeText,
    extractGeminiConversationIdsFromBatchexecuteText,
    normalizeOptions,
    resolvePlatformKind,
};
