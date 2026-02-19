import { GEMINI_RPC_IDS } from '@/platforms/constants';
import type { BatchexecuteResult } from '@/utils/google-rpc';
import { parseBatchexecuteResponse } from '@/utils/google-rpc';
import { logger } from '@/utils/logger';
import type { LRUCache } from '@/utils/lru-cache';
import { extractTitleCandidatesFromPayload } from './title-utils';

// ── Titles endpoint detection ──────────────────────────────────────────────────

export const isTitlesEndpoint = (url: string) => url.includes(`rpcids=${GEMINI_RPC_IDS.TITLES}`);

// ── Conversation ID extraction from URL ───────────────────────────────────────

const CONVERSATION_ID_IN_PAYLOAD_REGEX = /\bc_([a-zA-Z0-9_-]{8,})\b/;

export const extractConversationIdFromSourcePath = (url: string): string | null => {
    try {
        const parsed = new URL(url, 'https://gemini.google.com');
        const sourcePath = parsed.searchParams.get('source-path');
        if (sourcePath) {
            const match = sourcePath.match(/\/app\/([a-zA-Z0-9_-]+)/i);
            if (match?.[1]) {
                return match[1];
            }
        }
    } catch {
        // fall through to regex
    }
    return url.match(/[?&]source-path=%2Fapp%2F([a-zA-Z0-9_-]+)/i)?.[1] ?? null;
};

const extractConversationIdFromRawPayload = (rawPayload: string): string | null =>
    rawPayload.match(CONVERSATION_ID_IN_PAYLOAD_REGEX)?.[1] ?? null;

// ── RPC title hydration ────────────────────────────────────────────────────────

export const hydrateGeminiTitleCandidatesFromRpcResults = (
    rpcResults: BatchexecuteResult[],
    url: string,
    titlesCache: LRUCache<string, string>,
    onTitleUpdated?: (conversationId: string, title: string) => void,
): void => {
    const sourcePathConversationId = extractConversationIdFromSourcePath(url);

    for (const rpcResult of rpcResults) {
        const rawPayload = rpcResult.payload;
        if (typeof rawPayload !== 'string' || rawPayload.length === 0) {
            continue;
        }

        let parsedPayload: unknown;
        try {
            parsedPayload = JSON.parse(rawPayload);
        } catch {
            continue;
        }

        const titleCandidates = extractTitleCandidatesFromPayload(parsedPayload);
        if (titleCandidates.length === 0) {
            continue;
        }

        const conversationId = extractConversationIdFromRawPayload(rawPayload) ?? sourcePathConversationId;
        if (!conversationId) {
            continue;
        }

        const title = titleCandidates[0];
        const previousTitle = titlesCache.get(conversationId) ?? null;
        if (previousTitle === title) {
            continue;
        }

        titlesCache.set(conversationId, title);
        onTitleUpdated?.(conversationId, title);
        logger.info('[Blackiya/Gemini/Titles] Cached title candidate from RPC', {
            conversationId,
            rpcId: rpcResult.rpcId,
            title,
            previousTitle,
            sourcePathMatched: sourcePathConversationId === conversationId,
        });
    }
};

// ── Conversation-list titles (MaZiqc) ─────────────────────────────────────────

const parseGeminiTitlesPayload = (data: string): unknown => {
    const rpcResults = parseBatchexecuteResponse(data);
    const titleRpc = rpcResults.find((res) => res.rpcId === GEMINI_RPC_IDS.TITLES);
    if (!titleRpc?.payload) {
        logger.debug('[Blackiya/Gemini/Titles] No MaZiqc RPC result found');
        return null;
    }
    try {
        return JSON.parse(titleRpc.payload);
    } catch (error) {
        logger.warn('[Blackiya/Gemini/Titles] Failed to parse Gemini title RPC payload', {
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
};

const extractGeminiTitlesMap = (
    conversationList: unknown[],
    onTitleUpdated?: (convId: string, title: string) => void,
): Map<string, string> => {
    const titles = new Map<string, string>();
    for (const conv of conversationList) {
        if (!Array.isArray(conv) || conv.length < 2) {
            continue;
        }
        let [convId, title] = conv;
        if (typeof convId === 'string' && convId.startsWith('c_')) {
            convId = convId.slice(2);
        }
        if (typeof convId !== 'string' || typeof title !== 'string') {
            continue;
        }
        titles.set(convId, title);
        onTitleUpdated?.(convId, title);
    }
    return titles;
};

export const parseTitlesResponse = (
    data: string,
    url: string,
    onTitleUpdated?: (convId: string, title: string) => void,
): Map<string, string> | null => {
    try {
        logger.info('[Blackiya/Gemini/Titles] Attempting to parse titles from:', url);
        const payload = parseGeminiTitlesPayload(data);
        if (!payload) {
            return null;
        }

        if (!Array.isArray(payload) || payload.length < 3) {
            return null;
        }
        const conversationList = payload[2];
        if (!Array.isArray(conversationList)) {
            return null;
        }

        logger.info('[Blackiya/Gemini/Titles] Found conversation list with', conversationList.length, 'entries');
        return extractGeminiTitlesMap(conversationList, onTitleUpdated);
    } catch (e) {
        logger.error('[Blackiya/Gemini/Titles] Failed to parse titles:', e);
        return null;
    }
};

// ── Conversation RPC finding ───────────────────────────────────────────────────

const parseRpcPayload = (payload: string, rpcId: string): unknown => {
    try {
        return JSON.parse(payload);
    } catch (error) {
        logger.debug('[Blackiya/Gemini] Failed to parse RPC payload', {
            rpcId,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
};

const findExactConversationRpc = (results: BatchexecuteResult[]): { rpcId: string; payload: unknown } | null => {
    const exactMatch = results.find((res) => res.rpcId === GEMINI_RPC_IDS.CONVERSATION && res.payload);
    if (!exactMatch?.payload) {
        return null;
    }
    const payload = parseRpcPayload(exactMatch.payload, exactMatch.rpcId);
    if (!payload) {
        return null;
    }
    logger.info(`[Blackiya/Gemini] Found conversation data in RPC ID: ${exactMatch.rpcId}`);
    return { rpcId: exactMatch.rpcId, payload };
};

const findHeuristicConversationRpc = (
    results: BatchexecuteResult[],
    isConversationPayload: (payload: unknown) => boolean = () => true,
): { rpcId: string; payload: unknown } | null => {
    for (let i = results.length - 1; i >= 0; i--) {
        const res = results[i];
        if (!res.payload) {
            continue;
        }
        const payload = parseRpcPayload(res.payload, res.rpcId);
        if (!payload) {
            continue;
        }
        if (!isConversationPayload?.(payload)) {
            continue;
        }
        logger.info(
            `[Blackiya/Gemini] Found conversation data in RPC ID: ${res.rpcId} (heuristic, index ${i}/${results.length})`,
        );
        return { rpcId: res.rpcId, payload };
    }
    return null;
};

/**
 * Finds the valid conversation RPC from batchexecute results.
 * Priority: exact RPC ID match, then heuristic from end (richest chunk last).
 */
export const findConversationRpc = (
    results: BatchexecuteResult[],
    isConversationPayload?: (payload: unknown) => boolean,
): { rpcId: string; payload: unknown } | null =>
    findExactConversationRpc(results) ?? findHeuristicConversationRpc(results, isConversationPayload);

export { parseBatchexecuteResponse };
