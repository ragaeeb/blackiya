/**
 * ChatGPT Platform Adapter
 *
 * Implements the LLMPlatform interface for ChatGPT.
 * This module is intentionally thin: all logic lives in sibling modules.
 *
 * @module platforms/chatgpt
 */

import type { LLMPlatform } from '@/platforms/types';
import { generateTimestamp, sanitizeFilename } from '@/utils/download';
import { logger } from '@/utils/logger';
import type { ConversationData } from '@/utils/types';
import {
    deriveTitleFromFirstUserMessage,
    getConversationCandidate,
    normalizeConversationCandidate,
} from './conversation-normalizer';
import { evaluateChatGPTReadiness } from './readiness';
import { CHATGPT_ENDPOINT_REGISTRY, isChatGptGeneratingFromDom, resolveChatGptButtonInjectionTarget } from './registry';
import { buildConversationFromSsePayloads, extractSsePayloads } from './sse-parser';
import { CONVERSATION_ID_PATTERN, HOST_CANDIDATES, isPlaceholderTitle, tryParseJson } from './utils';

// Exported constants used by the interceptor / runner layers

export const CHATGPT_PROMPT_REQUEST_PATH_PATTERN = CHATGPT_ENDPOINT_REGISTRY.promptRequestPathPattern;

// Adapter factory

const MAX_TITLE_LENGTH = 80;

/**
 * Creates a ChatGPT Platform Adapter instance.
 *
 * Supports both chatgpt.com and legacy chat.openai.com domains.
 * Handles standard /c/{id} format and gizmo /g/{gizmo}/c/{id} format.
 */
export const createChatGPTAdapter = (): LLMPlatform => ({
    name: 'ChatGPT',

    urlMatchPattern: 'https://chatgpt.com/*',

    /**
     * Matches the GET endpoint for fetching full conversation JSON.
     * Format: backend-api/conversation/{uuid}
     */
    apiEndpointPattern: CHATGPT_ENDPOINT_REGISTRY.apiEndpointPattern,

    completionTriggerPattern: CHATGPT_ENDPOINT_REGISTRY.completionTriggerPattern,

    isPlatformUrl: (url: string) => url.includes('chatgpt.com') || url.includes('chat.openai.com'),

    /**
     * Extracts the conversation UUID from a ChatGPT page URL.
     *
     * Supports:
     *   https://chatgpt.com/c/{uuid}
     *   https://chatgpt.com/g/{gizmo-id}/c/{uuid}
     *   https://chat.openai.com/c/{uuid}
     */
    extractConversationId(url: string): string | null {
        let hostname: string | null = null;
        let pathname = '';

        if (typeof URL !== 'undefined') {
            try {
                const urlObj = new URL(url);
                hostname = urlObj.hostname;
                pathname = urlObj.pathname;
            } catch {
                return null;
            }
        } else {
            const match = url.match(/^https?:\/\/([^/]+)(\/[^?#]*)?/i);
            if (!match) {
                return null;
            }
            hostname = match[1];
            pathname = match[2] ?? '';
        }

        if (hostname !== 'chatgpt.com' && hostname !== 'chat.openai.com') {
            return null;
        }

        const pathMatch = pathname.match(/\/c\/([a-f0-9-]+)/i);
        if (!pathMatch) {
            return null;
        }

        const potentialId = pathMatch[1];
        return CONVERSATION_ID_PATTERN.test(potentialId) ? potentialId : null;
    },

    /** Extracts conversation ID from a stream_status completion trigger URL. */
    extractConversationIdFromUrl(url: string): string | null {
        const match = url.match(/\/backend-api\/(?:f\/)?conversation\/([a-f0-9-]+)\/stream_status/i);
        if (!match?.[1]) {
            return null;
        }
        return CONVERSATION_ID_PATTERN.test(match[1]) ? match[1] : null;
    },

    buildApiUrl: (conversationId: string) => `https://chatgpt.com/backend-api/conversation/${conversationId}`,

    buildApiUrls: (conversationId: string) => {
        const paths = [`/backend-api/conversation/${conversationId}`];
        return HOST_CANDIDATES.flatMap((host) => paths.map((path) => `${host}${path}`));
    },

    /**
     * Parses intercepted ChatGPT API response (JSON object or raw SSE text).
     */
    parseInterceptedData(data: string | any, _url: string): ConversationData | null {
        try {
            const parsed = typeof data === 'string' ? tryParseJson(data) : data;
            const directCandidate = normalizeConversationCandidate(getConversationCandidate(parsed));
            if (directCandidate) {
                return directCandidate;
            }

            if (typeof data === 'string') {
                const ssePayloads = extractSsePayloads(data);
                if (ssePayloads.length > 0) {
                    return buildConversationFromSsePayloads(ssePayloads);
                }
            }

            return null;
        } catch (e) {
            logger.error('Failed to parse ChatGPT data:', e);
            return null;
        }
    },

    /**
     * Formats a download filename: `{sanitized_title}_{YYYY-MM-DD_HH-MM-SS}`
     */
    formatFilename(data: ConversationData): string {
        let title = data.title || '';

        if (isPlaceholderTitle(title)) {
            title = deriveTitleFromFirstUserMessage(data.mapping);
        }

        if (!title.trim()) {
            title = `conversation_${data.conversation_id.slice(0, 8)}`;
        }

        let sanitizedTitle = sanitizeFilename(title);
        if (sanitizedTitle.length > MAX_TITLE_LENGTH) {
            sanitizedTitle = sanitizedTitle.slice(0, MAX_TITLE_LENGTH);
        }

        const timestamp = generateTimestamp(data.update_time || data.create_time);
        return `${sanitizedTitle}_${timestamp}`;
    },

    getButtonInjectionTarget: () => resolveChatGptButtonInjectionTarget(),

    evaluateReadiness: (data: ConversationData) => evaluateChatGPTReadiness(data),

    isPlatformGenerating: () => isChatGptGeneratingFromDom(),
});

/** ChatGPT Platform Adapter singleton. */
export const chatGPTAdapter: LLMPlatform = createChatGPTAdapter();
