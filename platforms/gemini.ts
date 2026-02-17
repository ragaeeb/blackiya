/**
 * Gemini Platform Adapter - With Title Support (Enhanced Logging)
 *
 * Enhancements:
 * 1. Intercepts MaZiqc RPC calls to capture conversation titles
 * 2. Caches title mappings (conversationId -> title)
 * 3. Uses cached titles when building ConversationData
 * 4. Enhanced logging to debug title extraction
 */

import { GEMINI_RPC_IDS } from '@/platforms/constants';
import type { LLMPlatform, PlatformReadiness } from '@/platforms/types';
import { generateTimestamp, sanitizeFilename } from '@/utils/download';
import type { BatchexecuteResult } from '@/utils/google-rpc';
import { parseBatchexecuteResponse } from '@/utils/google-rpc';
import { hashText } from '@/utils/hash';
import { logger } from '@/utils/logger';
import type { ConversationData, MessageNode } from '@/utils/types';

const MAX_TITLE_LENGTH = 80;

import { LRUCache } from '@/utils/lru-cache';

/**
 * We keep a small cache of message-titles to apply them
 * if they arrive *before* the message data.
 */
const conversationTitles = new LRUCache<string, string>(50);

/**
 * We also keep a reference to active conversations so we can update
 * their titles retroactively if the title arrives *after* the data.
 */
const activeConversations = new LRUCache<string, ConversationData>(50);

const GEMINI_GENERIC_TITLES = new Set([
    'gemini',
    'google gemini',
    'gemini conversation',
    'conversation with gemini',
    'new chat',
    'new conversation',
    'chats',
]);

const GEMINI_CONVERSATION_ID_IN_PAYLOAD_REGEX = /\bc_([a-zA-Z0-9_-]{8,})\b/;

function normalizeGeminiDomTitle(rawTitle: string): string {
    return rawTitle
        .replace(/\s*[-|]\s*Gemini(?:\s+Advanced)?$/i, '')
        .replace(/\s*[-|]\s*Google Gemini$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isGenericGeminiTitle(rawTitle: string): boolean {
    const normalized = normalizeGeminiDomTitle(rawTitle).toLowerCase();
    if (!normalized) {
        return true;
    }
    return (
        GEMINI_GENERIC_TITLES.has(normalized) ||
        normalized.startsWith('you said ') ||
        normalized.startsWith('you said:')
    );
}

function normalizeGeminiTitleCandidate(rawTitle: unknown): string | null {
    if (typeof rawTitle !== 'string') {
        return null;
    }
    const normalized = normalizeGeminiDomTitle(rawTitle).replace(/\s+/g, ' ').trim();
    if (normalized.length < 3 || normalized.length > 180) {
        return null;
    }
    if (normalized.includes('\n')) {
        return null;
    }
    if (isGenericGeminiTitle(normalized)) {
        return null;
    }
    return normalized;
}

function collectGeminiTitleCandidates(node: unknown, out: string[], depth = 0): void {
    if (depth > 8 || out.length >= 16 || !node || typeof node !== 'object') {
        return;
    }

    if (Array.isArray(node)) {
        for (const child of node) {
            collectGeminiTitleCandidates(child, out, depth + 1);
        }
        return;
    }

    const obj = node as Record<string, unknown>;
    const candidateSlots: unknown[] = [];

    if (Object.hasOwn(obj, '11')) {
        const key11 = obj['11'];
        if (Array.isArray(key11)) {
            candidateSlots.push(...key11);
        } else {
            candidateSlots.push(key11);
        }
    }

    if (Object.hasOwn(obj, 'title')) {
        candidateSlots.push(obj.title);
    }

    for (const candidate of candidateSlots) {
        const normalized = normalizeGeminiTitleCandidate(candidate);
        if (normalized && !out.includes(normalized)) {
            out.push(normalized);
        }
    }

    for (const value of Object.values(obj)) {
        collectGeminiTitleCandidates(value, out, depth + 1);
    }
}

function extractGeminiTitleCandidatesFromPayload(payload: unknown): string[] {
    const candidates: string[] = [];
    collectGeminiTitleCandidates(payload, candidates);
    return candidates;
}

function extractGeminiConversationIdFromSourcePath(url: string): string | null {
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
        // Fall back to regex parsing below.
    }

    const encodedMatch = url.match(/[?&]source-path=%2Fapp%2F([a-zA-Z0-9_-]+)/i);
    return encodedMatch?.[1] ?? null;
}

function extractGeminiConversationIdFromRawPayload(rawPayload: string): string | null {
    const match = rawPayload.match(GEMINI_CONVERSATION_ID_IN_PAYLOAD_REGEX);
    return match?.[1] ?? null;
}

function hydrateGeminiTitleCandidatesFromRpcResults(
    rpcResults: BatchexecuteResult[],
    url: string,
    titlesCache: LRUCache<string, string>,
): void {
    const sourcePathConversationId = extractGeminiConversationIdFromSourcePath(url);

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

        const titleCandidates = extractGeminiTitleCandidatesFromPayload(parsedPayload);
        if (titleCandidates.length === 0) {
            continue;
        }

        const conversationId = extractGeminiConversationIdFromRawPayload(rawPayload) ?? sourcePathConversationId;
        if (!conversationId) {
            continue;
        }

        const title = titleCandidates[0];
        const previousTitle = titlesCache.get(conversationId) ?? null;
        if (previousTitle === title) {
            continue;
        }

        titlesCache.set(conversationId, title);
        maybeUpdateActiveGeminiConversationTitle(conversationId, title);
        logger.info('[Blackiya/Gemini/Titles] Cached title candidate from RPC', {
            conversationId,
            rpcId: rpcResult.rpcId,
            title,
            previousTitle,
            sourcePathMatched: sourcePathConversationId === conversationId,
        });
    }
}

function extractTitleFromGeminiDomHeadings(): string | null {
    if (typeof document === 'undefined') {
        return null;
    }

    const selectors = ['main h1', 'main [role="heading"][aria-level="1"]', 'main [role="heading"]', 'header h1', 'h1'];

    for (const selector of selectors) {
        const nodes = document.querySelectorAll(selector);
        for (const node of nodes) {
            const candidate = normalizeGeminiDomTitle((node.textContent ?? '').trim());
            if (!candidate || isGenericGeminiTitle(candidate)) {
                continue;
            }
            return candidate;
        }
    }

    return null;
}

function extractTitleFromGeminiActiveConversationNav(): string | null {
    if (typeof document === 'undefined') {
        return null;
    }

    const selectors = [
        'nav a[aria-current="page"]',
        'nav button[aria-current="page"]',
        'aside a[aria-current="page"]',
        'aside button[aria-current="page"]',
        '[role="tab"][aria-selected="true"]',
        'nav [aria-selected="true"]',
    ];

    for (const selector of selectors) {
        const nodes = document.querySelectorAll(selector);
        for (const node of nodes) {
            const candidate = normalizeGeminiDomTitle((node.textContent ?? '').trim());
            if (!candidate || isGenericGeminiTitle(candidate)) {
                continue;
            }
            return candidate;
        }
    }

    return null;
}

/**
 * Parse the MaZiqc response to extract conversation titles
 */
function getGeminiTitlesPayload(data: string): unknown | null {
    const rpcResults = parseBatchexecuteResponse(data);
    const titleRpc = rpcResults.find((res) => res.rpcId === GEMINI_RPC_IDS.TITLES);
    if (!titleRpc?.payload) {
        logger.debug('[Blackiya/Gemini/Titles] No MaZiqc RPC result found');
        return null;
    }
    return JSON.parse(titleRpc.payload);
}

function getGeminiConversationList(payload: unknown): unknown[] | null {
    if (!Array.isArray(payload) || payload.length < 3) {
        return null;
    }
    const conversationList = payload[2];
    return Array.isArray(conversationList) ? conversationList : null;
}

function maybeUpdateActiveGeminiConversationTitle(convId: string, title: string): void {
    const activeObj = activeConversations.get(convId);
    if (!activeObj?.title || activeObj.title === title) {
        return;
    }
    activeObj.title = title;
    logger.info(`[Blackiya/Gemini/Titles] Updated: ${convId} -> "${title}"`);
}

function extractGeminiTitlesMap(conversationList: unknown[]): Map<string, string> {
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
        maybeUpdateActiveGeminiConversationTitle(convId, title);
    }
    return titles;
}

function parseTitlesResponse(data: string, url: string): Map<string, string> | null {
    try {
        logger.info('[Blackiya/Gemini/Titles] Attempting to parse titles from:', url);
        const payload = getGeminiTitlesPayload(data);
        if (!payload) {
            return null;
        }
        const conversationList = getGeminiConversationList(payload);
        if (!conversationList) {
            return null;
        }

        logger.info('[Blackiya/Gemini/Titles] Found conversation list with', conversationList.length, 'entries');
        return extractGeminiTitlesMap(conversationList);
    } catch (e) {
        logger.error('[Blackiya/Gemini/Titles] Failed to parse titles:', e);
        return null;
    }
}

/**
 * Check if a URL is a MaZiqc (conversation list) endpoint
 */
function isTitlesEndpoint(url: string): boolean {
    const isTitles = url.includes('rpcids=MaZiqc');
    if (isTitles) {
        logger.info('[Blackiya/Gemini/Titles] Detected titles endpoint');
    }
    return isTitles;
}

/**
 * Finds the valid conversation RPC from a list of batchexecute results.
 *
 * Priority:
 * 1. Exact RPC ID match (hNvQHb — standard batchexecute)
 * 2. Heuristic payload match, searching from the END of results so that
 *    StreamGenerate's last (richest) chunk is preferred over early partial chunks.
 */
function findConversationRpc(
    results: BatchexecuteResult[],
    isConversationPayload?: (payload: any) => boolean,
): { rpcId: string; payload: any } | null {
    // Priority 1: Exact RPC ID match
    const exactMatch = results.find((res) => res.rpcId === GEMINI_RPC_IDS.CONVERSATION && res.payload);
    if (exactMatch?.payload) {
        try {
            const payload = JSON.parse(exactMatch.payload);
            logger.info(`[Blackiya/Gemini] Found conversation data in RPC ID: ${exactMatch.rpcId}`);
            return { rpcId: exactMatch.rpcId, payload };
        } catch {}
    }

    // Priority 2: Heuristic match — search from END for richest StreamGenerate chunk
    for (let i = results.length - 1; i >= 0; i--) {
        const res = results[i];
        if (!res.payload) {
            continue;
        }

        try {
            const payload = JSON.parse(res.payload);
            if (isConversationPayload?.(payload)) {
                logger.info(
                    `[Blackiya/Gemini] Found conversation data in RPC ID: ${res.rpcId} (heuristic, index ${i}/${results.length})`,
                );
                return { rpcId: res.rpcId, payload };
            }
        } catch {}
    }

    return null;
}

type GeminiConversationEnvelope = {
    conversationRoot: any[];
    isStreamFormat: boolean;
};

function resolveGeminiConversationEnvelope(payload: any): GeminiConversationEnvelope | null {
    const batchexecuteRoot = payload?.[0]?.[0];
    if (Array.isArray(batchexecuteRoot)) {
        return { conversationRoot: batchexecuteRoot, isStreamFormat: false };
    }

    if (Array.isArray(payload) && payload[0] === null && Array.isArray(payload[1])) {
        return { conversationRoot: payload, isStreamFormat: true };
    }

    return null;
}

function normalizeGeminiConversationId(rawConversationId: unknown): string | null {
    if (typeof rawConversationId !== 'string' || rawConversationId.length === 0) {
        return null;
    }
    return rawConversationId.startsWith('c_') ? rawConversationId.slice(2) : rawConversationId;
}

function extractGeminiConversationId(conversationRoot: any[], isStreamFormat: boolean): string | null {
    const idArray = isStreamFormat ? conversationRoot[1] : conversationRoot[0];
    const rawConversationId = Array.isArray(idArray) ? idArray[0] : null;
    return normalizeGeminiConversationId(rawConversationId);
}

function resolveGeminiConversationTitle(conversationId: string | null, titlesCache: LRUCache<string, string>): string {
    if (!conversationId) {
        return 'Gemini Conversation';
    }
    return titlesCache.has(conversationId) ? titlesCache.get(conversationId)! : 'Gemini Conversation';
}

function extractGeminiTextNode(node: any): string {
    if (typeof node === 'string') {
        return node;
    }
    if (!Array.isArray(node) || node.length === 0) {
        return '';
    }
    if (node.length >= 3 && node[0] === null && typeof node[2] === 'string') {
        return node[2];
    }
    return extractGeminiTextNode(node[0]);
}

function parseGeminiThoughtsFromAssistantCandidate(assistantCandidate: any[]): any[] {
    const reasoningData = assistantCandidate[37];
    const thinkingText = reasoningData?.[0]?.[0];
    if (typeof thinkingText !== 'string' || thinkingText.length === 0) {
        return [];
    }

    const thoughts: any[] = [];
    const sections = thinkingText.split(/\n\*\*([^*]+)\*\*\n/);
    for (let i = 1; i < sections.length; i += 2) {
        const title = sections[i]?.trim();
        const content = sections[i + 1]?.trim();
        if (!title || !content) {
            continue;
        }
        thoughts.push({
            summary: title,
            content,
            chunks: [],
            finished: true,
        });
    }
    return thoughts;
}

function parseGeminiMessages(conversationRoot: any[], isStreamFormat: boolean): any[] {
    const parsedMessages: any[] = [];

    if (!isStreamFormat) {
        const userSlot = conversationRoot[2];
        if (Array.isArray(userSlot)) {
            const rawUserContent = extractGeminiTextNode(userSlot);
            if (rawUserContent) {
                parsedMessages.push({
                    role: 'user',
                    content: rawUserContent,
                });
            }
        }
    }

    const assistantSlot = isStreamFormat ? conversationRoot[4] : conversationRoot[3];
    const assistantCandidate = isStreamFormat ? assistantSlot?.[0] : assistantSlot?.[0]?.[0];
    if (!Array.isArray(assistantCandidate)) {
        return parsedMessages;
    }

    const textParts = assistantCandidate[1];
    const assistantContent = Array.isArray(textParts) ? (textParts[0] as string) || '' : '';
    const thoughts = parseGeminiThoughtsFromAssistantCandidate(assistantCandidate);
    if (assistantContent || thoughts.length > 0) {
        parsedMessages.push({
            role: 'assistant',
            content: assistantContent,
            thoughts: thoughts.length > 0 ? thoughts : undefined,
        });
    }

    return parsedMessages;
}

function extractGeminiModelName(conversationRoot: any[], isStreamFormat: boolean): string {
    const defaultModelName = 'gemini-2.0';
    const modelSlotSource = isStreamFormat ? conversationRoot[4] : conversationRoot[3];
    if (!Array.isArray(modelSlotSource) || modelSlotSource.length <= 21) {
        return defaultModelName;
    }
    const modelSlug = modelSlotSource[21];
    if (typeof modelSlug !== 'string') {
        return defaultModelName;
    }
    const modelName = `gemini-${modelSlug.toLowerCase().replace(/\s+/g, '-')}`;
    logger.info('[Blackiya/Gemini] Extracted model name:', modelName);
    return modelName;
}

function buildGeminiConversationMapping(parsedMessages: any[]): Record<string, MessageNode> {
    const mapping: Record<string, MessageNode> = {};
    const now = Date.now() / 1000;

    parsedMessages.forEach((msg, index) => {
        const id = `segment-${index}`;
        mapping[id] = {
            id,
            message: {
                id,
                author: {
                    role: msg.role,
                    name: msg.role === 'user' ? 'User' : 'Gemini',
                    metadata: {},
                },
                content: {
                    content_type: msg.thoughts ? 'thoughts' : 'text',
                    parts: [msg.content],
                    thoughts: msg.thoughts,
                },
                create_time: now,
                update_time: now,
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
            parent: index === 0 ? null : `segment-${index - 1}`,
            children: index < parsedMessages.length - 1 ? [`segment-${index + 1}`] : [],
        };
    });

    return mapping;
}

function buildGeminiConversationData(
    conversationId: string | null,
    conversationTitle: string,
    mapping: Record<string, MessageNode>,
    modelName: string,
): ConversationData {
    const now = Date.now() / 1000;
    return {
        title: conversationTitle,
        create_time: now,
        update_time: now,
        conversation_id: conversationId || 'unknown',
        mapping,
        current_node: `segment-${Math.max(0, Object.keys(mapping).length - 1)}`,
        is_archived: false,
        safe_urls: [],
        blocked_urls: [],
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        default_model_slug: modelName,
    };
}

/**
 * Parses the conversation payload into Blackiya's standardized ConversationData
 */
function parseConversationPayload(
    payload: any,
    titlesCache: LRUCache<string, string>,
    activeConvos: LRUCache<string, ConversationData>,
): ConversationData | null {
    const envelope = resolveGeminiConversationEnvelope(payload);
    if (!envelope) {
        logger.info('[Blackiya/Gemini] Invalid conversation root structure');
        return null;
    }
    const { conversationRoot, isStreamFormat } = envelope;

    const conversationId = extractGeminiConversationId(conversationRoot, isStreamFormat);

    logger.info('[Blackiya/Gemini] Extracted conversation ID:', conversationId);

    const conversationTitle = resolveGeminiConversationTitle(conversationId, titlesCache);

    logger.info('[Blackiya/Gemini] Title lookup:', {
        conversationId,
        cached: conversationId ? titlesCache.has(conversationId) : false,
        title: conversationTitle,
    });

    const parsedMessages = parseGeminiMessages(conversationRoot, isStreamFormat);
    const mapping = buildGeminiConversationMapping(parsedMessages);
    const modelName = extractGeminiModelName(conversationRoot, isStreamFormat);

    logger.info('[Blackiya/Gemini] Successfully parsed conversation with', Object.keys(mapping).length, 'messages');

    const conversationData = buildGeminiConversationData(conversationId, conversationTitle, mapping, modelName);

    // Store in active conversations map for potential retroactive title updates
    if (conversationId) {
        activeConvos.set(conversationId, conversationData);
    }

    return conversationData;
}

function evaluateGeminiReadiness(data: ConversationData): PlatformReadiness {
    const messages = Object.values(data.mapping)
        .map((node) => node.message)
        .filter(
            (message): message is NonNullable<MessageNode['message']> =>
                !!message && message.author.role === 'assistant',
        )
        .sort((left, right) => {
            const leftTs = left.update_time ?? left.create_time ?? 0;
            const rightTs = right.update_time ?? right.create_time ?? 0;
            return leftTs - rightTs;
        });

    if (messages.length === 0) {
        return {
            ready: false,
            terminal: false,
            reason: 'assistant-missing',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    if (messages.some((message) => message.status === 'in_progress')) {
        return {
            ready: false,
            terminal: false,
            reason: 'assistant-in-progress',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    const latest = messages[messages.length - 1];
    const latestText = (latest.content.parts ?? []).filter((part): part is string => typeof part === 'string').join('');
    const normalized = latestText.trim().normalize('NFC');

    if (normalized.length === 0) {
        return {
            ready: false,
            terminal: true,
            reason: 'assistant-text-missing',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    if (latest.status !== 'finished_successfully' || latest.end_turn !== true) {
        return {
            ready: false,
            terminal: true,
            reason: 'assistant-latest-text-not-terminal-turn',
            contentHash: null,
            latestAssistantTextLength: normalized.length,
        };
    }

    return {
        ready: true,
        terminal: true,
        reason: 'terminal',
        contentHash: hashText(normalized),
        latestAssistantTextLength: normalized.length,
    };
}

function isGeminiConversationIdCandidate(value: unknown): boolean {
    return typeof value === 'string' && (value.startsWith('c_') || /^[a-f0-9]+$/i.test(value));
}

function hasGeminiBatchexecuteConversationShape(payload: any): boolean {
    if (!Array.isArray(payload) || payload.length === 0) {
        return false;
    }
    const level1 = payload[0];
    if (!Array.isArray(level1) || level1.length === 0) {
        return false;
    }
    const conversationRoot = level1[0];
    if (!Array.isArray(conversationRoot) || conversationRoot.length < 3) {
        return false;
    }
    const idArray = conversationRoot[0];
    if (!Array.isArray(idArray) || idArray.length < 2) {
        return false;
    }
    return isGeminiConversationIdCandidate(idArray[0]);
}

function hasGeminiStreamGenerateConversationShape(payload: any): boolean {
    if (!Array.isArray(payload) || payload.length === 0) {
        return false;
    }
    if (payload[0] !== null || !Array.isArray(payload[1]) || payload[1].length < 1) {
        return false;
    }
    return isGeminiConversationIdCandidate(payload[1][0]);
}

export const geminiAdapter: LLMPlatform = {
    name: 'Gemini',
    urlMatchPattern: 'https://gemini.google.com/*',

    // Match Gemini API endpoints that carry conversation data:
    // - Legacy/new batchexecute RPC envelopes (RPC IDs can drift, e.g. ESY5D)
    // - Gemini 3.0 StreamGenerate endpoint (V2.1-025 fix)
    apiEndpointPattern:
        /\/_\/BardChatUi\/data\/(?:batchexecute(?:\?.*)?|assistant\.lamda\.BardFrontendService\/StreamGenerate)/,
    completionTriggerPattern:
        /\/_\/BardChatUi\/data\/(?:batchexecute(?:\?.*)?|assistant\.lamda\.BardFrontendService\/StreamGenerate)/,

    isPlatformUrl(url: string): boolean {
        return url.includes('gemini.google.com');
    },

    extractConversationId(url: string): string | null {
        if (!this.isPlatformUrl(url)) {
            return null;
        }

        const appMatch = url.match(/\/app\/([a-zA-Z0-9_-]+)/i);
        if (appMatch) {
            return appMatch[1];
        }

        const shareMatch = url.match(/\/share\/([a-zA-Z0-9_-]+)/i);
        if (shareMatch) {
            return shareMatch[1];
        }
        return null;
    },

    extractConversationIdFromUrl(_url: string): string | null {
        // Gemini batchexecute URLs do not reliably contain the conversation ID.
        // We fall back to the currently active conversation ID from the page URL.
        return null;
    },

    parseInterceptedData(data: string, url: string): ConversationData | null {
        // Check if this is a titles endpoint
        if (isTitlesEndpoint(url)) {
            const titles = parseTitlesResponse(data, url);
            if (titles) {
                // Merge into global cache
                for (const [id, title] of titles) {
                    conversationTitles.set(id, title);
                }
                logger.info(`[Blackiya/Gemini] Title cache now contains ${conversationTitles.size} entries`);

                // Log current cache contents for debugging
                logger.info(
                    '[Blackiya/Gemini] Current cached conversation IDs:',
                    Array.from(conversationTitles.keys()).slice(0, 5),
                );
            } else {
                logger.info('[Blackiya/Gemini/Titles] Failed to extract titles from this response');
            }
            // Don't return ConversationData for title endpoints
            return null;
        }

        // Otherwise, parse as conversation data
        try {
            logger.info('[Blackiya/Gemini] Attempting to parse response from:', url);

            const rpcResults = parseBatchexecuteResponse(data);
            hydrateGeminiTitleCandidatesFromRpcResults(rpcResults, url, conversationTitles);

            const conversationRpc = findConversationRpc(rpcResults, this.isConversationPayload);
            if (!conversationRpc) {
                logger.info('[Blackiya/Gemini] No RPC result with conversation data found');
                return null;
            }

            logger.info(`[Blackiya/Gemini] Using RPC ID: ${conversationRpc.rpcId}`);

            return parseConversationPayload(conversationRpc.payload, conversationTitles, activeConversations);
        } catch (e) {
            logger.error('[Blackiya/Gemini] Failed to parse:', e);
            if (e instanceof Error) {
                logger.error('[Blackiya/Gemini] Error stack:', e.stack);
            }
            return null;
        }
    },

    /**
     * Helper to detect if a payload contains conversation data
     */
    isConversationPayload(payload: any): boolean {
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

    defaultTitles: ['Gemini Conversation', 'Google Gemini', 'Conversation with Gemini'],

    extractTitleFromDom() {
        if (typeof document === 'undefined') {
            return null;
        }

        const tabTitle = normalizeGeminiDomTitle(document.title?.trim() ?? '');
        if (tabTitle && !isGenericGeminiTitle(tabTitle)) {
            return tabTitle;
        }

        const headingTitle = extractTitleFromGeminiDomHeadings();
        if (headingTitle) {
            return headingTitle;
        }

        const sidebarTitle = extractTitleFromGeminiActiveConversationNav();
        if (sidebarTitle) {
            return sidebarTitle;
        }

        return null;
    },
};
