/**
 * Grok Platform Adapter
 *
 * Supports grok.com and x.com Grok conversations across:
 * - GrokConversationItemsByRestId (x.com GraphQL)
 * - GrokHistory (x.com GraphQL — titles)
 * - grok.com REST: conversations_v2, response-node, load-responses, conversations/new
 * - add_response.json (x.com streaming NDJSON)
 * - reconnect-response-v2 (grok.com streaming NDJSON)
 */

import type { LLMPlatform } from '@/platforms/types';
import { generateTimestamp, sanitizeFilename } from '@/utils/download';
import { logger } from '@/utils/logger';
import type { ConversationData } from '@/utils/types';
import { tryParseGrokComRestEndpoint, tryParseJsonIfNeeded } from './grok-com-parser';
import { tryParseGrokNdjson } from './ndjson-parser';
import { evaluateGrokReadiness } from './readiness';
import { tryHandleGrokTitlesEndpoint } from './titles';
import {
    extractGrokComConversationIdFromUrl,
    extractXConversationIdFromApiUrl,
    GROK_COM_CONVERSATION_ID_PATTERN,
    resolveXGraphqlConversationId,
    X_CONVERSATION_ID_PATTERN,
} from './url-utils';
import { parseGrokResponse } from './x-graphql-parser';

export { GrokAdapterState, resetGrokAdapterState } from './state';

const MAX_TITLE_LENGTH = 80;

const parseDefaultGrokPayload = (data: string | any, url: string): ConversationData | null => {
    try {
        const parsed = tryParseJsonIfNeeded(data);
        if (!parsed) {
            if (typeof data === 'string' && data.includes('\n')) {
                return tryParseGrokNdjson(data, url);
            }
            return null;
        }
        return parseGrokResponse(parsed, resolveXGraphqlConversationId(url));
    } catch (e) {
        if (typeof data === 'string' && data.includes('\n')) {
            return tryParseGrokNdjson(data, url);
        }
        logger.error('[Blackiya/Grok] Failed to parse data:', e);
        return null;
    }
};

export const grokAdapter: LLMPlatform = {
    name: 'Grok',
    urlMatchPattern: 'https://grok.com/*',

    apiEndpointPattern:
        /\/i\/api\/graphql\/[^/]+\/(GrokConversationItemsByRestId|GrokHistory)|\/2\/grok\/add_response\.json|grok\.com\/rest\/app-chat\/conversations(_v2)?\/(?:new|reconnect-response-v2\/[^/?#]+|[^/]+(?:\/(response-node|load-responses))?)/,
    completionTriggerPattern:
        /\/i\/api\/graphql\/[^/]+\/GrokConversationItemsByRestId|\/2\/grok\/add_response\.json|grok\.com\/rest\/app-chat\/conversations\/(new|[^/]+\/(response-node|load-responses))/,

    isPlatformUrl(url: string): boolean {
        try {
            const { hostname, pathname } = new URL(url);
            if (hostname === 'grok.com' || hostname === 'www.grok.com') {
                return true;
            }
            return hostname === 'x.com' && pathname.startsWith('/i/grok');
        } catch {
            return false;
        }
    },

    extractConversationId(url: string): string | null {
        try {
            const urlObj = new URL(url);

            if (urlObj.hostname === 'grok.com') {
                if (!urlObj.pathname.startsWith('/c/')) {
                    return null;
                }
                const match = urlObj.pathname.match(/\/c\/([a-f0-9-]+)/i);
                const conversationId = match?.[1] ?? null;
                if (!conversationId) {
                    return null;
                }
                return GROK_COM_CONVERSATION_ID_PATTERN.test(conversationId) ? conversationId : null;
            }

            if (urlObj.hostname !== 'x.com') {
                return null;
            }
            if (!urlObj.pathname.startsWith('/i/grok')) {
                return null;
            }

            const conversationId = urlObj.searchParams.get('conversation');
            if (!conversationId) {
                return null;
            }
            return X_CONVERSATION_ID_PATTERN.test(conversationId) ? conversationId : null;
        } catch {
            return null;
        }
    },

    extractConversationIdFromUrl(url: string): string | null {
        return extractGrokComConversationIdFromUrl(url) ?? extractXConversationIdFromApiUrl(url);
    },

    buildApiUrls(conversationId: string): string[] {
        if (!GROK_COM_CONVERSATION_ID_PATTERN.test(conversationId)) {
            return [];
        }
        return [
            `https://grok.com/rest/app-chat/conversations/${conversationId}/load-responses`,
            `https://grok.com/rest/app-chat/conversations/${conversationId}/response-node?includeThreads=true`,
            `https://grok.com/rest/app-chat/conversations_v2/${conversationId}?includeWorkspaces=true&includeTaskResult=true`,
        ];
    },

    parseInterceptedData(data: string | any, url: string): ConversationData | null {
        const _dbgPath = (() => {
            try {
                return new URL(url).pathname;
            } catch {
                return url.slice(0, 120);
            }
        })();
        logger.info('[Blackiya/Grok] parseInterceptedData entry', {
            path: _dbgPath,
            dataLen: typeof data === 'string' ? data.length : -1,
        });

        if (tryHandleGrokTitlesEndpoint(data, url)) {
            return null;
        }

        const grokComResult = tryParseGrokComRestEndpoint(data, url);
        if (grokComResult !== undefined) {
            return grokComResult;
        }

        return parseDefaultGrokPayload(data, url);
    },

    formatFilename(data: ConversationData): string {
        let title = data.title || '';
        if (!title.trim()) {
            const idPart =
                data.conversation_id && data.conversation_id.length >= 8
                    ? data.conversation_id.slice(0, 8)
                    : data.conversation_id || 'unknown';
            title = `grok_conversation_${idPart}`;
        }
        const sanitizedTitle = sanitizeFilename(title).slice(0, MAX_TITLE_LENGTH);
        const timestamp = generateTimestamp(data.update_time || data.create_time);
        return `${sanitizedTitle}_${timestamp}`;
    },

    getButtonInjectionTarget(): HTMLElement | null {
        const selectors = ['[data-testid="grok-header"]', '[role="banner"]', 'header nav', 'header', 'body'];
        for (const selector of selectors) {
            const target = document.querySelector(selector);
            if (target) {
                return (target.parentElement || target) as HTMLElement;
            }
        }
        return null;
    },

    evaluateReadiness(data: ConversationData) {
        return evaluateGrokReadiness(data);
    },

    isPlatformGenerating() {
        // TODO(v2.0.x): Implement Grok DOM generation detection once stable selectors are identified.
        return false;
    },

    defaultTitles: ['New conversation', 'Grok Conversation'],

    extractTitleFromDom(): string | null {
        const raw = document.title?.trim();
        if (!raw) {
            return null;
        }
        const cleaned = raw.replace(/\s*-\s*Grok$/i, '').trim();
        if (!cleaned || cleaned.toLowerCase() === 'grok') {
            return null;
        }
        if (this.defaultTitles?.some((d: string) => d.toLowerCase() === cleaned.toLowerCase())) {
            return null;
        }
        return cleaned;
    },
};
