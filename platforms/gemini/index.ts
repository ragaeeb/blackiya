/**
 * Gemini Platform Adapter
 *
 * Intercepts batchexecute RPC and StreamGenerate responses to capture
 * conversation data, titles, and lifecycle readiness signals.
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
import { extractTitleFromGeminiDom, GEMINI_DEFAULT_TITLES } from './title-utils';

export { GeminiAdapterState };
export { resetGeminiAdapterState } from './state';

const MAX_TITLE_LENGTH = 80;

const maybeUpdateActiveConversationTitle = (convId: string, title: string): void => {
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

    apiEndpointPattern:
        /\/_\/BardChatUi\/data\/(?:batchexecute(?:\?.*)?|assistant\.lamda\.BardFrontendService\/StreamGenerate)/,
    completionTriggerPattern:
        /\/_\/BardChatUi\/data\/(?:batchexecute(?:\?.*)?|assistant\.lamda\.BardFrontendService\/StreamGenerate)/,

    isPlatformUrl: (url: string) => url.includes('gemini.google.com'),

    extractConversationId(url: string): string | null {
        if (!this.isPlatformUrl(url)) {
            return null;
        }
        return url.match(/\/app\/([a-zA-Z0-9_-]+)/i)?.[1] ?? url.match(/\/share\/([a-zA-Z0-9_-]+)/i)?.[1] ?? null;
    },

    extractConversationIdFromUrl(_url: string): string | null {
        // Gemini batchexecute URLs do not reliably contain the conversation ID.
        return null;
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
            logger.info('[Blackiya/Gemini] Attempting to parse response from:', url);
            const rpcResults = parseBatchexecuteResponse(data);
            hydrateGeminiTitleCandidatesFromRpcResults(
                rpcResults,
                url,
                geminiState.conversationTitles,
                maybeUpdateActiveConversationTitle,
            );

            const conversationRpc = findConversationRpc(rpcResults, this.isConversationPayload);
            if (!conversationRpc) {
                logger.info('[Blackiya/Gemini] No RPC result with conversation data found');
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

    getButtonInjectionTarget(): HTMLElement | null {
        const selectors = [
            'header [aria-haspopup="menu"]',
            'header .flex-1.overflow-hidden',
            'header nav',
            '.chat-app-header',
            'header',
            '[role="banner"]',
            'body',
        ];
        for (const selector of selectors) {
            const target = document.querySelector(selector);
            if (target) {
                return (target.parentElement || target) as HTMLElement;
            }
        }
        return null;
    },

    evaluateReadiness(data: ConversationData) {
        return evaluateGeminiReadiness(data);
    },

    isPlatformGenerating() {
        // Gemini generation gating is driven by network lifecycle/SFE signals.
        return false;
    },

    defaultTitles: GEMINI_DEFAULT_TITLES,

    extractTitleFromDom() {
        return extractTitleFromGeminiDom();
    },
};
