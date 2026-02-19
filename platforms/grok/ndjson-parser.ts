import { logger } from '@/utils/logger';
import type { ConversationData } from '@/utils/types';
import { getOrCreateGrokComConversation, hasGrokComMessages, parseGrokComResponses } from './grok-com-parser';
import { grokState } from './state';
import { extractGrokComConversationIdFromUrl, GROK_COM_CONVERSATION_ID_PATTERN } from './url-utils';

export const parseGrokNdjsonLines = (lines: string[]): any[] => {
    const parsedLines: any[] = [];
    for (const line of lines) {
        try {
            parsedLines.push(JSON.parse(line));
        } catch {
            // Skip unparseable lines — one bad line must not break the rest.
        }
    }
    return parsedLines;
};

const extractConversationIdFromParsedLine = (parsed: any): string | null => {
    const direct = parsed?.conversationId;
    if (typeof direct === 'string' && GROK_COM_CONVERSATION_ID_PATTERN.test(direct)) {
        return direct;
    }
    const nested = parsed?.result?.conversation?.conversationId;
    if (typeof nested === 'string' && GROK_COM_CONVERSATION_ID_PATTERN.test(nested)) {
        return nested;
    }
    return null;
};

export const resolveGrokNdjsonConversationId = (url: string, parsedLines: any[]): string | null => {
    let conversationId = extractGrokComConversationIdFromUrl(url);
    if (!conversationId) {
        for (const parsed of parsedLines) {
            conversationId = extractConversationIdFromParsedLine(parsed);
            if (conversationId) {
                break;
            }
        }
    }
    if (conversationId) {
        return conversationId;
    }

    const lastActive = grokState.lastActiveConversationId;
    if (lastActive) {
        logger.info('[Blackiya/Grok] NDJSON using last-active conversation ID', { conversationId: lastActive });
        return lastActive;
    }
    return null;
};

// ── Conversation building from NDJSON lines ────────────────────────────────────

const parseNdjsonConversation = (parsedLines: any[], conversationId: string): ConversationData | null => {
    const conversation = getOrCreateGrokComConversation(conversationId);
    let foundMessages = false;
    for (const parsed of parsedLines) {
        const result = parseGrokComResponses(parsed, conversationId);
        if (result && hasGrokComMessages(result)) {
            foundMessages = true;
        }
    }
    return foundMessages ? conversation : null;
};

// ── Public entry point ─────────────────────────────────────────────────────────

/**
 * Resilient NDJSON parser for Grok streaming endpoints.
 *
 * Parses each line independently (one bad line doesn't break the rest),
 * resolves the conversation ID from the URL, payload, or last-active fallback,
 * then delegates message building to the grok.com response parsers.
 */
export const tryParseGrokNdjson = (data: string, url: string): ConversationData | null => {
    const lines = data.split('\n').filter((line) => line.trim());
    if (lines.length < 2) {
        return null;
    }

    logger.info(`[Blackiya/Grok] Parsing NDJSON fallback (${lines.length} lines)`, { url: url.slice(0, 120) });

    const parsedLines = parseGrokNdjsonLines(lines);
    if (parsedLines.length === 0) {
        return null;
    }

    const conversationId = resolveGrokNdjsonConversationId(url, parsedLines);
    if (!conversationId) {
        logger.info('[Blackiya/Grok] NDJSON could not determine conversation ID');
        return null;
    }

    return parseNdjsonConversation(parsedLines, conversationId);
};
