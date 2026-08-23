/**
 * Gemini Platform Adapter
 *
 * Intercepts batchexecute RPC and StreamGenerate responses to capture
 * conversation data, titles, and terminal readiness evaluation.
 */

import type { LLMPlatform } from '@/platforms/types';
import { generateTimestamp, sanitizeFilename } from '@/utils/download';
import { parseBatchexecuteResponse } from '@/utils/google-rpc';
import { logger } from '@/utils/logger';
import type { ConversationData } from '@/utils/types';
import {
    evaluateGeminiReadiness,
    hasGeminiBatchexecuteConversationShape,
    hasGeminiStreamGenerateConversationShape,
    parseConversationPayload,
} from './conversation-parser';
import {
    findConversationRpc,
    hydrateGeminiTitleCandidatesFromRpcResults,
    isTitlesEndpoint,
    parseTitlesResponse,
} from './rpc-parser';
import { GeminiAdapterState, geminiState } from './state';

export { resetGeminiAdapterState } from './state';
export { GeminiAdapterState };

const MAX_TITLE_LENGTH = 80;
const GEMINI_HOSTNAME = 'gemini.google.com';

const isGeminiUrl = (url: string) => {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.hostname === GEMINI_HOSTNAME;
    } catch {
        return false;
    }
};

const maybeUpdateActiveConversationTitle = (convId: string, title: string) => {
    const activeObj = geminiState.activeConversations.get(convId);
    if (!activeObj?.title || activeObj.title === title) {
        return;
    }
    activeObj.title = title;
    logger.info(`[Blackiya/Gemini/Titles] Updated: ${convId} -> "${title}"`);
};

export const geminiAdapter: LLMPlatform = {
    name: 'Gemini',
    urlMatchPattern: 'https://gemini.google.com/*',

    isPlatformUrl: isGeminiUrl,

    extractConversationId(url: string): string | null {
        if (!this.isPlatformUrl(url)) {
            return null;
        }
        return url.match(/\/app\/([a-zA-Z0-9_-]+)/i)?.[1] ?? url.match(/\/share\/([a-zA-Z0-9_-]+)/i)?.[1] ?? null;
    },

    isConversationDetailRequest(url: string, method: string): boolean {
        if (method.toUpperCase() !== 'POST') {
            return false;
        }
        try {
            const parsed = new URL(url);
            return (
                parsed.hostname === 'gemini.google.com' &&
                parsed.pathname.toLowerCase() === '/_/bardchatui/data/batchexecute' &&
                parsed.searchParams.get('rpcids')?.split(',').includes('hNvQHb') === true
            );
        } catch {
            return false;
        }
    },

    parseInterceptedData(data: string, url: string): ConversationData | null {
        if (isTitlesEndpoint(url)) {
            const titles = parseTitlesResponse(data, url, maybeUpdateActiveConversationTitle);
            if (titles) {
                for (const [id, title] of titles) {
                    geminiState.conversationTitles.set(id, title);
                }
                logger.info(
                    `[Blackiya/Gemini] Title cache now contains ${geminiState.conversationTitles.size} entries`,
                );
                logger.info(
                    '[Blackiya/Gemini] Current cached conversation IDs:',
                    Array.from(geminiState.conversationTitles.keys()).slice(0, 5),
                );
            } else {
                logger.info('[Blackiya/Gemini/Titles] Failed to extract titles from this response');
            }
            return null;
        }

        try {
            logger.debug('[Blackiya/Gemini] Attempting to parse response from:', url);
            const rpcResults = parseBatchexecuteResponse(data);
            hydrateGeminiTitleCandidatesFromRpcResults(
                rpcResults,
                url,
                geminiState.conversationTitles,
                maybeUpdateActiveConversationTitle,
            );

            const conversationRpc = findConversationRpc(rpcResults, this.isConversationPayload);
            if (!conversationRpc) {
                logger.debug('[Blackiya/Gemini] No RPC result with conversation data found');
                return null;
            }

            logger.info(`[Blackiya/Gemini] Using RPC ID: ${conversationRpc.rpcId}`);
            return parseConversationPayload(
                conversationRpc.payload,
                geminiState.conversationTitles,
                geminiState.activeConversations,
            );
        } catch (e) {
            logger.error('[Blackiya/Gemini] Failed to parse:', e);
            if (e instanceof Error) {
                logger.error('[Blackiya/Gemini] Error stack:', e.stack);
            }
            return null;
        }
    },

    isConversationPayload(payload: unknown): boolean {
        try {
            return hasGeminiBatchexecuteConversationShape(payload) || hasGeminiStreamGenerateConversationShape(payload);
        } catch {
            return false;
        }
    },

    formatFilename(data: ConversationData): string {
        const title = data.title || 'Gemini_Conversation';
        const sanitizedTitle = sanitizeFilename(title).slice(0, MAX_TITLE_LENGTH);
        const timestamp = generateTimestamp(data.update_time);
        return `${sanitizedTitle}_${timestamp}`;
    },

    evaluateReadiness(data: ConversationData) {
        return evaluateGeminiReadiness(data);
    },
};
