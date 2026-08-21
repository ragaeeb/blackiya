import type { LLMPlatform } from '@/platforms/types';
import type { ConversationData } from '@/utils/types';
import type { FetchContext } from './fetch';
import { fetchText } from './fetch';
import type { NormalizedOptions } from './options';
import {
    extractGrokComConversationIdsFromPayload,
    extractGrokComConversationIdsFromText,
    extractGrokResponseIdsFromNodeText,
} from './parsers-grok';
import type { ConversationListResult } from './provider-chatgpt';
import { asRecord, firstNonNull, parseJsonSafe, readString, uniqueStrings } from './utils';

const preserveRawFallbackPayload = (conversation: ConversationData, responseText: string): ConversationData => ({
    ...conversation,
    raw_payload: parseJsonSafe(responseText) ?? responseText,
}) as ConversationData;

const resolveGrokComNextCursor = (payload: unknown): string | null => {
    const record = asRecord(payload);
    const cursor = firstNonNull([
        readString(record, 'nextCursor'),
        readString(record, 'next_cursor'),
        readString(record, 'cursor'),
    ]);
    return cursor && cursor.length > 0 ? cursor : null;
};

const fetchGrokComConversationPage = async (cursor: string | null, fetchContext: FetchContext) => {
    const pageSize = 100;
    const cursorPart = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const url = `https://grok.com/rest/app-chat/conversations?pageSize=${pageSize}${cursorPart}`;
    const response = await fetchText(url, fetchContext);
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

export const listConversationIdsGrokCom = async (
    options: NormalizedOptions,
    fetchContext: FetchContext,
): Promise<ConversationListResult> => {
    const limit = options.maxItems;
    const ids: string[] = [];
    const warnings: string[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    while (limit === null || ids.length < limit) {
        const page = await fetchGrokComConversationPage(cursor, fetchContext);
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

export const buildGrokDetailUrls = (adapter: LLMPlatform, conversationId: string): string[] => {
    const fromAdapter = adapter.buildApiUrls?.(conversationId) ?? [];
    const urls =
        fromAdapter.length > 0
            ? fromAdapter
            : [
                  `https://grok.com/rest/app-chat/conversations_v2/${conversationId}?includeWorkspaces=true&includeTaskResult=true`,
                  `https://grok.com/rest/app-chat/conversations/${conversationId}/response-node?includeThreads=true`,
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

export const fetchConversationByIdGrokCom = async (
    conversationId: string,
    adapter: LLMPlatform,
    fetchContext: FetchContext,
): Promise<ConversationData | null> => {
    const reconnectResponseIds: string[] = [];

    for (const url of buildGrokDetailUrls(adapter, conversationId)) {
        const response = await fetchText(url, fetchContext);
        if (!response.ok) {
            continue;
        }

        if (url.includes('/response-node')) {
            reconnectResponseIds.push(...extractGrokResponseIdsFromNodeText(response.text));
        }

        const conversation = adapter.parseInterceptedData(response.text, url);
        if (conversation) {
            return url.includes('/response-node') ? preserveRawFallbackPayload(conversation, response.text) : conversation;
        }
    }

    for (const responseId of uniqueStrings(reconnectResponseIds)) {
        const reconnectUrl = `https://grok.com/rest/app-chat/conversations/reconnect-response-v2/${responseId}`;
        const response = await fetchText(reconnectUrl, fetchContext);
        if (!response.ok) {
            continue;
        }
        const conversation = adapter.parseInterceptedData(response.text, reconnectUrl);
        if (conversation) {
            return preserveRawFallbackPayload(conversation, response.text);
        }
    }

    return null;
};
