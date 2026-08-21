import { GEMINI_RPC_IDS } from '@/platforms/constants';
import type { LLMPlatform } from '@/platforms/types';
import type { GeminiBatchexecuteContext } from '@/utils/gemini-batchexecute-context';
import type { ConversationData } from '@/utils/types';
import type { FetchContext } from './fetch';
import { fetchText } from './fetch';
import type { NormalizedOptions } from './options';
import { extractGeminiConversationIdsFromBatchexecuteText } from './parsers-gemini';
import type { ConversationListResult } from './provider-chatgpt';
import { resolveHostFromLocation, uniqueStrings } from './utils';

const GEMINI_BATCHEXECUTE_PATH = '/_/BardChatUi/data/batchexecute';

export const listConversationIdsGemini = async (
    options: NormalizedOptions,
    fetchContext: FetchContext,
    locationHref: string,
    adapter: LLMPlatform,
): Promise<ConversationListResult> => {
    const warnings: string[] = [];
    const host = resolveHostFromLocation(locationHref, 'gemini.google.com');
    const locationConversationId = adapter.extractConversationId(locationHref);
    const sourcePath = locationConversationId ? `/app/${locationConversationId}` : '/app';
    const url = `https://${host}${GEMINI_BATCHEXECUTE_PATH}?rpcids=${GEMINI_RPC_IDS.TITLES}&source-path=${encodeURIComponent(sourcePath)}&rt=c`;
    const response = await fetchText(url, fetchContext);
    if (!response.ok) {
        warnings.push(
            `Gemini titles list request failed: status=${response.status} message=${response.message || 'Unknown error'}`,
        );
        return { ids: [], warnings };
    }

    const parsedIds = extractGeminiConversationIdsFromBatchexecuteText(response.text);
    if (parsedIds.length > 0) {
        return {
            ids: options.maxItems === null
                ? uniqueStrings(parsedIds)
                : uniqueStrings(parsedIds).slice(0, options.maxItems),
            warnings,
        };
    }

    warnings.push('Gemini titles endpoint returned no parseable conversation ids.');
    return { ids: [], warnings };
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

export const buildGeminiDetailUrls = (host: string, conversationId: string): string[] => {
    const urls = [
        `https://${host}${GEMINI_BATCHEXECUTE_PATH}?rpcids=${GEMINI_RPC_IDS.CONVERSATION}&source-path=${encodeURIComponent(`/app/${conversationId}`)}&rt=c`,
        `https://${host}${GEMINI_BATCHEXECUTE_PATH}?rpcids=${GEMINI_RPC_IDS.CONVERSATION}&source-path=${encodeURIComponent('/app')}&rt=c&conversation_id=${encodeURIComponent(conversationId)}`,
    ];
    const seen = new Set<string>();
    return urls.filter((url) => {
        if (seen.has(url)) {
            return false;
        }
        seen.add(url);
        return true;
    });
};

export const buildGeminiPostRequest = (
    host: string,
    conversationId: string,
    geminiContext: GeminiBatchexecuteContext,
    authHeaders: Record<string, string> | undefined,
): { url: string; headers: Record<string, string>; body: string } => {
    if (!geminiContext.at) {
        throw new Error('Gemini batchexecute context is missing the at token.');
    }
    const url = buildGeminiConversationPostUrl(host, conversationId, geminiContext);
    const headers = {
        ...(authHeaders ?? {}),
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    };
    const body = buildGeminiConversationPostBody(conversationId, geminiContext.at);
    return { url, headers, body };
};

export const fetchConversationByIdGemini = async (
    conversationId: string,
    adapter: LLMPlatform,
    fetchContext: FetchContext,
    locationHref: string,
    geminiContext: GeminiBatchexecuteContext | undefined,
): Promise<ConversationData | null> => {
    const host = resolveHostFromLocation(locationHref, 'gemini.google.com');

    if (!geminiContext?.at) {
        return null;
    }

    const postRequest = buildGeminiPostRequest(host, conversationId, geminiContext, fetchContext.authHeaders);
    const response = await fetchText(postRequest.url, fetchContext, {
        method: 'POST',
        headers: postRequest.headers,
        body: postRequest.body,
    });
    if (response.ok) {
        const conversation = adapter.parseInterceptedData(response.text, postRequest.url);
        if (conversation) {
            return conversation;
        }
    }

    return null;
};
