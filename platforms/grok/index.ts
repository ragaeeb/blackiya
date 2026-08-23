/**
 * Grok Platform Adapter
 *
 * Supports grok.com conversations across:
 * - grok.com REST: conversations_v2, response-node, load-responses, conversations/new
 * - add_response.json (Grok streaming NDJSON)
 * - reconnect-response-v2 (grok.com streaming NDJSON)
 */

import type { LLMPlatform } from '@/platforms/types';
import { generateTimestamp, sanitizeFilename } from '@/utils/download';
import { logger } from '@/utils/logger';
import type { ConversationData } from '@/utils/types';
import { tryParseGrokComRestEndpoint, tryParseJsonIfNeeded } from './grok-com-parser';
import { tryParseGrokNdjson } from './ndjson-parser';
import { evaluateGrokReadiness } from './readiness';
import { GROK_COM_CONVERSATION_ID_PATTERN } from './url-utils';
import { parseXGrokConversationItems } from './x-conversation-parser';
import {
    buildXGrokConversationItemsUrl,
    extractXGrokConversationId,
    isXGrokConversationItemsEndpoint,
} from './x-url-utils';

export { GrokAdapterState, grokState, resetGrokAdapterState } from './state';

const MAX_TITLE_LENGTH = 80;
const parseDefaultGrokPayload = (data: string | any, url: string): ConversationData | null => {
    if (typeof data === 'string' && data.includes('\n')) {
        return tryParseGrokNdjson(data, url);
    }
    tryParseJsonIfNeeded(data);
    return null;
};

export const grokAdapter: LLMPlatform = {
    name: 'Grok',
    urlMatchPattern: 'https://grok.com/*',

    isPlatformUrl(url: string): boolean {
        try {
            const urlObj = new URL(url);
            const { hostname } = urlObj;
            if (hostname === 'grok.com' || hostname === 'www.grok.com' || hostname === 'grok.x.com') {
                return true;
            }
            return (
                (hostname === 'x.com' || hostname === 'www.x.com') &&
                (urlObj.pathname === '/i/grok' || isXGrokConversationItemsEndpoint(url))
            );
        } catch {
            return false;
        }
    },

    extractConversationId(url: string): string | null {
        try {
            const urlObj = new URL(url);

            const xConversationId = extractXGrokConversationId(url);
            if (xConversationId) {
                return xConversationId;
            }
            if (urlObj.hostname !== 'grok.com' && urlObj.hostname !== 'www.grok.com') {
                return null;
            }
            if (!urlObj.pathname.startsWith('/c/')) {
                return null;
            }
            const match = urlObj.pathname.match(/\/c\/([a-f0-9-]+)/i);
            const conversationId = match?.[1] ?? null;
            if (!conversationId) {
                return null;
            }
            return GROK_COM_CONVERSATION_ID_PATTERN.test(conversationId) ? conversationId : null;
        } catch {
            return null;
        }
    },

    buildApiUrls(conversationId: string): string[] {
        const xUrl = buildXGrokConversationItemsUrl(conversationId);
        if (xUrl) {
            return [xUrl];
        }
        if (!GROK_COM_CONVERSATION_ID_PATTERN.test(conversationId)) {
            return [];
        }
        return [
            `https://grok.com/rest/app-chat/conversations_v2/${conversationId}?includeWorkspaces=true&includeTaskResult=true`,
            `https://grok.com/rest/app-chat/conversations/${conversationId}/response-node?includeThreads=true`,
        ];
    },

    isConversationDetailRequest(url: string, method: string): boolean {
        if (method.toUpperCase() !== 'GET') {
            return false;
        }
        return (
            isXGrokConversationItemsEndpoint(url) ||
            url.includes('/rest/app-chat/conversations_v2/') ||
            (url.includes('/rest/app-chat/conversations/') &&
                (url.includes('/response-node') || url.includes('/load-responses')))
        );
    },

    parseInterceptedData(data: string | any, url: string): ConversationData | null {
        let _dbgPath: string;
        try {
            _dbgPath = new URL(url).pathname;
        } catch {
            _dbgPath = url.slice(0, 120);
        }
        logger.info('[Blackiya/Grok] parseInterceptedData entry', {
            path: _dbgPath,
            dataLen: typeof data === 'string' ? data.length : -1,
        });

        const xResult = parseXGrokConversationItems(data, url);
        if (xResult) {
            return xResult;
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

    evaluateReadiness(data: ConversationData) {
        return evaluateGrokReadiness(data);
    },
};
