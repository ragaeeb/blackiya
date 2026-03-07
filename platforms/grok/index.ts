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
import {
    GROK_DEFAULT_TITLES,
    GROK_ENDPOINT_REGISTRY,
    GROK_SELECTOR_REGISTRY,
    resolveGrokButtonInjectionTarget,
} from './registry';
import { extractGrokComConversationIdFromUrl, GROK_COM_CONVERSATION_ID_PATTERN } from './url-utils';

export { GrokAdapterState, grokState, resetGrokAdapterState } from './state';

const MAX_TITLE_LENGTH = 80;
const GROK_GENERIC_DOM_TITLES = new Set(['grok']);

const normalizeDomTitle = (value: string | null | undefined): string => value?.replace(/\s+/g, ' ').trim() ?? '';

const normalizeGrokDomTitleCandidate = (raw: string, defaultTitles: readonly string[]): string | null => {
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

const queryGrokTitleFromDom = (defaultTitles: readonly string[]): string | null => {
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
    if (typeof data === 'string' && data.includes('\n')) {
        return tryParseGrokNdjson(data, url);
    }
    tryParseJsonIfNeeded(data);
    return null;
};

export const grokAdapter: LLMPlatform = {
    name: 'Grok',
    urlMatchPattern: 'https://grok.com/*',

    apiEndpointPattern: GROK_ENDPOINT_REGISTRY.apiEndpointPattern,
    completionTriggerPattern: GROK_ENDPOINT_REGISTRY.completionTriggerPattern,

    isPlatformUrl(url: string): boolean {
        try {
            const { hostname } = new URL(url);
            return hostname === 'grok.com' || hostname === 'www.grok.com';
        } catch {
            return false;
        }
    },

    extractConversationId(url: string): string | null {
        try {
            const urlObj = new URL(url);

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

    extractConversationIdFromUrl(url: string): string | null {
        return extractGrokComConversationIdFromUrl(url);
    },

    buildApiUrls(conversationId: string): string[] {
        if (!GROK_COM_CONVERSATION_ID_PATTERN.test(conversationId)) {
            return [];
        }
        return [
            `https://grok.com/rest/app-chat/conversations_v2/${conversationId}?includeWorkspaces=true&includeTaskResult=true`,
            `https://grok.com/rest/app-chat/conversations/${conversationId}/response-node?includeThreads=true`,
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
        return resolveGrokButtonInjectionTarget();
    },

    evaluateReadiness(data: ConversationData) {
        return evaluateGrokReadiness(data);
    },

    isPlatformGenerating() {
        // Grok generation gating is driven by network lifecycle/SFE signals.
        return false;
    },

    defaultTitles: GROK_DEFAULT_TITLES,

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
