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
import { GROK_ENDPOINT_REGISTRY, GROK_SELECTOR_REGISTRY, resolveGrokButtonInjectionTarget } from './registry';
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
const GROK_GENERIC_DOM_TITLES = new Set(['grok', 'grok / x', 'x / grok']);

const normalizeDomTitle = (value: string | null | undefined): string => value?.replace(/\s+/g, ' ').trim() ?? '';

const normalizeGrokDomTitleCandidate = (raw: string, defaultTitles: string[]): string | null => {
    const normalized = normalizeDomTitle(raw);
    if (!normalized) {
        return null;
    }
    const lower = normalized.toLowerCase();
    if (GROK_GENERIC_DOM_TITLES.has(lower)) {
        return null;
    }
    if (defaultTitles.some((title) => normalizeDomTitle(title).toLowerCase() === lower)) {
        return null;
    }
    return normalized;
};

const queryGrokTitleFromDom = (defaultTitles: string[]): string | null => {
    for (const selector of GROK_SELECTOR_REGISTRY.domTitleCandidates) {
        const element = document.querySelector(selector);
        const text = normalizeDomTitle(element?.textContent ?? null);
        if (!text) {
            continue;
        }
        const normalized = normalizeGrokDomTitleCandidate(text, defaultTitles);
        if (normalized) {
            return normalized;
        }
    }

    return null;
};

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

    apiEndpointPattern: GROK_ENDPOINT_REGISTRY.apiEndpointPattern,
    completionTriggerPattern: GROK_ENDPOINT_REGISTRY.completionTriggerPattern,

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
        try {
            const { hostname, pathname } = window.location;
            if (hostname === 'x.com' && pathname.startsWith('/i/grok')) {
                return document.body ?? document.documentElement;
            }
        } catch {
            // Fallback to selector-based target resolution.
        }
        return resolveGrokButtonInjectionTarget();
    },

    evaluateReadiness(data: ConversationData) {
        return evaluateGrokReadiness(data);
    },

    isPlatformGenerating() {
        // Grok generation gating is driven by network lifecycle/SFE signals.
        return false;
    },

    defaultTitles: ['New conversation', 'Grok Conversation', 'Grok / X'],

    extractTitleFromDom(): string | null {
        const defaultTitles = this.defaultTitles ?? [];
        const titleFromPage = normalizeGrokDomTitleCandidate(
            normalizeDomTitle(document.title).replace(/\s*-\s*Grok$/i, ''),
            defaultTitles,
        );
        if (titleFromPage) {
            return titleFromPage;
        }
        return queryGrokTitleFromDom(defaultTitles);
    },
};
