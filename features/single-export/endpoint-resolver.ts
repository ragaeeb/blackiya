/**
 * v3 single-export endpoint resolver.
 *
 * Pure functions that map a platform adapter + conversation id to deterministic
 * detail requests (URL, method, headers, body). The resolver is
 * intentionally side-effect free so it is trivial to unit-test.
 *
 * @module features/single-export/endpoint-resolver
 */

import { GEMINI_RPC_IDS } from '@/platforms/constants';
import type { LLMPlatform } from '@/platforms/types';
import type { GeminiBatchexecuteContext } from '@/utils/gemini-batchexecute-context';

const GEMINI_BATCHEXECUTE_PATH = '/_/BardChatUi/data/batchexecute';
const GROK_COM_CONVERSATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * The coarse platform kind used by the resolver. Independent of the adapter
 * name string so that an adapter rename or vendor change does not silently
 * change routing.
 */
export type PlatformKind = 'chatgpt' | 'gemini' | 'grok' | 'unsupported';

const isChatGptHost = (hostname: string): boolean => hostname === 'chatgpt.com' || hostname === 'chat.openai.com';

const isGeminiHost = (hostname: string): boolean =>
    hostname === 'gemini.google.com' || hostname.endsWith('.gemini.google.com');

const isGrokComHost = (hostname: string): boolean => hostname === 'grok.com' || hostname === 'www.grok.com';

const resolveHost = (pageUrl: string, fallback: string): string => {
    try {
        const { hostname } = new URL(pageUrl);
        return hostname || fallback;
    } catch {
        return fallback;
    }
};

/**
 * Maps an adapter + page URL to a `PlatformKind`. Returns `'unsupported'`
 * when the adapter does not match the page origin (e.g., the ChatGPT adapter
 * is being asked to handle a Gemini page — caller should fail closed).
 */
export const resolvePlatformKind = (adapter: LLMPlatform | null, pageUrl: string): PlatformKind => {
    if (!adapter) {
        return 'unsupported';
    }
    let hostname: string;
    try {
        hostname = new URL(pageUrl).hostname.toLowerCase();
    } catch {
        return 'unsupported';
    }
    let adapterAcceptsUrl = false;
    try {
        adapterAcceptsUrl = adapter.isPlatformUrl(pageUrl);
    } catch {
        adapterAcceptsUrl = false;
    }
    if (adapter.name === 'ChatGPT' && (isChatGptHost(hostname) || adapterAcceptsUrl)) {
        return 'chatgpt';
    }
    if (adapter.name === 'Gemini' && (isGeminiHost(hostname) || adapterAcceptsUrl)) {
        return 'gemini';
    }
    if (adapter.name === 'Grok' && (isGrokComHost(hostname) || adapterAcceptsUrl)) {
        return 'grok';
    }
    return 'unsupported';
};

/**
 * The fully-resolved HTTP request the single-export kernel should dispatch.
 *
 * `body` and `headers` are pre-baked so the service layer does not need to
 * understand platform-specific framing.
 */
export type DetailRequest = {
    url: string;
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    /**
     * True when the platform requires a non-cookie auth context to complete
     * the request (e.g. Gemini's `at` token). Used by the kernel to
     * differentiate `missing_auth` from generic `missing_endpoint`.
     */
    requiresAuthContext: boolean;
};

export type DetailResolutionInput = {
    platform: PlatformKind;
    adapter: LLMPlatform;
    conversationId: string;
    pageUrl: string;
    geminiContext?: GeminiBatchexecuteContext | undefined;
};

export type DetailResolutionResult =
    | { ok: true; requests: DetailRequest[] }
    | { ok: false; reason: 'missing_endpoint' | 'missing_auth' };

const firstString = (values: Array<string | undefined | null>): string | null => {
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }
    return null;
};

const uniqueNonEmptyStrings = (values: Array<string | undefined | null>): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        if (typeof value !== 'string' || value.length === 0 || seen.has(value)) {
            continue;
        }
        seen.add(value);
        result.push(value);
    }
    return result;
};

const buildChatGptDetail = (adapter: LLMPlatform, conversationId: string): DetailResolutionResult => {
    const primary = adapter.buildApiUrl?.(conversationId);
    const candidates = adapter.buildApiUrls?.(conversationId);
    const urls = uniqueNonEmptyStrings([primary, ...(Array.isArray(candidates) ? candidates : [])]);
    if (urls.length > 0) {
        return {
            ok: true,
            requests: urls.map((url) => ({ url, method: 'GET', requiresAuthContext: false })),
        };
    }
    return { ok: false, reason: 'missing_endpoint' };
};

const buildGrokDetail = (adapter: LLMPlatform, conversationId: string, _pageUrl: string): DetailResolutionResult => {
    if (!GROK_COM_CONVERSATION_ID_PATTERN.test(conversationId)) {
        return { ok: false, reason: 'missing_endpoint' };
    }
    const candidates = adapter.buildApiUrls?.(conversationId);
    const urls = uniqueNonEmptyStrings(Array.isArray(candidates) ? candidates : []);
    if (urls.length > 0) {
        return {
            ok: true,
            requests: urls.map((url) => ({ url, method: 'GET', requiresAuthContext: false })),
        };
    }
    return {
        ok: true,
        requests: [
            {
                url: `https://grok.com/rest/app-chat/conversations_v2/${conversationId}?includeWorkspaces=true&includeTaskResult=true`,
                method: 'GET',
                requiresAuthContext: false,
            },
        ],
    };
};

const buildGeminiPostBody = (conversationId: string, at: string): string => {
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

const buildGeminiDetail = (
    _adapter: LLMPlatform,
    conversationId: string,
    pageUrl: string,
    context: GeminiBatchexecuteContext | undefined,
): DetailResolutionResult => {
    const at = firstString([context?.at]);
    if (!at) {
        return { ok: false, reason: 'missing_auth' };
    }
    const host = resolveHost(pageUrl, 'gemini.google.com');
    const params = new URLSearchParams();
    params.set('rpcids', GEMINI_RPC_IDS.CONVERSATION);
    params.set('source-path', `/app/${conversationId}`);
    const bl = firstString([context?.bl]);
    if (bl) {
        params.set('bl', bl);
    }
    const fSid = firstString([context?.fSid]);
    if (fSid) {
        params.set('f.sid', fSid);
    }
    const hl = firstString([context?.hl]);
    if (hl) {
        params.set('hl', hl);
    }
    const baseReqId = typeof context?.reqid === 'number' && Number.isFinite(context.reqid) ? context.reqid : null;
    const reqid = baseReqId !== null ? Math.max(0, Math.floor(baseReqId)) + 1 : Date.now() % 10_000_000;
    params.set('_reqid', `${reqid}`);
    params.set('rt', firstString([context?.rt]) ?? 'c');
    return {
        ok: true,
        requests: [
            {
                url: `https://${host}${GEMINI_BATCHEXECUTE_PATH}?${params.toString()}`,
                method: 'POST',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                },
                body: buildGeminiPostBody(conversationId, at),
                requiresAuthContext: true,
            },
        ],
    };
};

/**
 * Build the deterministic detail request for the supplied platform kind.
 *
 * The resolver is intentionally non-throwing: every failure case is
 * reported as a typed `{ ok: false, reason }` so the service layer can map
 * it into the right `SingleExportError` variant.
 */
export const buildDetailRequest = (input: DetailResolutionInput): DetailResolutionResult => {
    if (input.platform === 'chatgpt') {
        return buildChatGptDetail(input.adapter, input.conversationId);
    }
    if (input.platform === 'grok') {
        return buildGrokDetail(input.adapter, input.conversationId, input.pageUrl);
    }
    if (input.platform === 'gemini') {
        return buildGeminiDetail(input.adapter, input.conversationId, input.pageUrl, input.geminiContext);
    }
    return { ok: false, reason: 'missing_endpoint' };
};
