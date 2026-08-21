import type { LLMPlatform } from '@/platforms/types';
import type { ConversationData } from '@/utils/types';
import type { FetchContext } from './fetch';
import { fetchFirstSuccessfulResponse, fetchText } from './fetch';
import type { NormalizedOptions } from './options';
import { extractChatGptConversationIdsFromPayload, extractChatGptConversationIdsFromText } from './parsers-chatgpt';
import { parseJsonSafe, resolveHostFromLocation, uniqueStrings } from './utils';

export const CHATGPT_HOSTS = ['chatgpt.com', 'chat.openai.com'] as const;

export type ConversationListResult = {
    ids: string[];
    warnings: string[];
};

const buildChatGptListUrls = (host: string, offset: number, pageSize: number) => [
    `https://${host}/backend-api/conversations?offset=${offset}&limit=${pageSize}&order=updated&is_archived=false&is_starred=false`,
    `https://${host}/backend-api/conversations?offset=${offset}&limit=${pageSize}&order=updated&is_archived=false`,
    `https://${host}/backend-api/conversations?offset=${offset}&limit=${pageSize}&order=updated`,
];

const parseChatGptListPageIds = (responseText: string): string[] => {
    const parsedPayload = parseJsonSafe(responseText);
    const fromPayload = extractChatGptConversationIdsFromPayload(parsedPayload);
    return fromPayload.length > 0 ? fromPayload : extractChatGptConversationIdsFromText(responseText);
};

export const listConversationIdsChatGpt = async (
    options: NormalizedOptions,
    fetchContext: FetchContext,
    locationHref: string,
): Promise<ConversationListResult> => {
    const limit = options.maxItems;
    const ids: string[] = [];
    const warnings: string[] = [];
    let offset = 0;
    const pageSize = 100;

    while (limit === null || ids.length < limit) {
        const fallbackHost = CHATGPT_HOSTS[0];
        const currentHost = resolveHostFromLocation(locationHref, fallbackHost);
        const host = CHATGPT_HOSTS.find((candidate) => candidate === currentHost) ?? fallbackHost;
        const response = await fetchFirstSuccessfulResponse(buildChatGptListUrls(host, offset, pageSize), fetchContext);

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

export const buildChatGptDetailUrls = (adapter: LLMPlatform, conversationId: string, host: string): string[] => {
    const fromAdapter = adapter.buildApiUrls?.(conversationId) ?? [];
    const primary = adapter.buildApiUrl?.(conversationId);
    const fallback = [`https://${host}/backend-api/conversation/${conversationId}`];
    const urls = [...(primary ? [primary] : []), ...fromAdapter, ...fallback];
    const seen = new Set<string>();
    return urls.filter((url) => {
        if (seen.has(url)) {
            return false;
        }
        seen.add(url);
        return true;
    });
};

export const fetchConversationByIdChatGpt = async (
    conversationId: string,
    adapter: LLMPlatform,
    fetchContext: FetchContext,
    locationHref: string,
): Promise<ConversationData | null> => {
    const host = resolveHostFromLocation(locationHref, CHATGPT_HOSTS[0]);
    for (const url of buildChatGptDetailUrls(adapter, conversationId, host)) {
        const response = await fetchText(url, fetchContext);
        if (!response.ok) {
            continue;
        }
        const conversation = adapter.parseInterceptedData(response.text, url);
        if (conversation) {
            return conversation;
        }
    }
    return null;
};
