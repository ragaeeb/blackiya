import type { PlatformReadiness } from '@/platforms/types';
import { hashText } from '@/utils/hash';
import { logger } from '@/utils/logger';
import type { LRUCache } from '@/utils/lru-cache';
import type { ConversationData, MessageNode } from '@/utils/types';

const isConversationIdCandidate = (value: unknown): value is string =>
    typeof value === 'string' && (value.startsWith('c_') || /^[a-f0-9]+$/i.test(value));

export const hasGeminiBatchexecuteConversationShape = (payload: unknown): boolean => {
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
    return isConversationIdCandidate(idArray[0]);
};

type StreamShapeIndices = { idIndex: number; assistantSlotIndex: number };

const resolveGeminiStreamShape = (payload: unknown): StreamShapeIndices | null => {
    if (!Array.isArray(payload) || payload.length < 5) {
        return null;
    }
    for (let i = 0; i <= payload.length - 5; i++) {
        if (payload[i] !== null) {
            continue;
        }
        const idCandidate = payload[i + 1];
        if (!Array.isArray(idCandidate) || !isConversationIdCandidate(idCandidate[0])) {
            continue;
        }
        const assistantSlot = payload[i + 4];
        if (!Array.isArray(assistantSlot)) {
            continue;
        }
        return { idIndex: i + 1, assistantSlotIndex: i + 4 };
    }
    return null;
};

export const hasGeminiStreamGenerateConversationShape = (payload: unknown): boolean =>
    !!resolveGeminiStreamShape(payload);

type ConversationEnvelope = { conversationRoot: unknown[]; isStreamFormat: boolean };

export const resolveGeminiConversationEnvelope = (payload: unknown): ConversationEnvelope | null => {
    const payloadArray = Array.isArray(payload) ? payload : null;
    const level1 = Array.isArray(payloadArray?.[0]) ? payloadArray[0] : null;
    const batchexecuteRoot = Array.isArray(level1) ? level1[0] : null;
    if (Array.isArray(batchexecuteRoot)) {
        return { conversationRoot: batchexecuteRoot, isStreamFormat: false };
    }

    const streamShape = resolveGeminiStreamShape(payload);
    if (streamShape && payloadArray) {
        const conversationRoot = [
            null,
            payloadArray[streamShape.idIndex],
            null,
            null,
            payloadArray[streamShape.assistantSlotIndex],
        ];
        return { conversationRoot, isStreamFormat: true };
    }
    return null;
};

const normalizeConversationId = (rawConversationId: unknown): string | null => {
    if (typeof rawConversationId !== 'string' || rawConversationId.length === 0) {
        return null;
    }
    return rawConversationId.startsWith('c_') ? rawConversationId.slice(2) : rawConversationId;
};

export const extractGeminiConversationId = (conversationRoot: unknown, isStreamFormat: boolean): string | null => {
    if (!Array.isArray(conversationRoot)) {
        return null;
    }
    const idArray = isStreamFormat ? conversationRoot[1] : conversationRoot[0];
    return normalizeConversationId(Array.isArray(idArray) ? idArray[0] : null);
};

export const resolveGeminiConversationTitle = (
    conversationId: string | null,
    titlesCache: LRUCache<string, string>,
): string =>
    conversationId && titlesCache.has(conversationId) ? titlesCache.get(conversationId)! : 'Gemini Conversation';

const extractGeminiTextNode = (node: unknown, depth = 0, maxDepth = 50): string => {
    if (typeof node === 'string') {
        return node;
    }
    if (!Array.isArray(node) || node.length === 0 || depth >= maxDepth) {
        return '';
    }
    if (node.length >= 3 && node[0] === null && typeof node[2] === 'string') {
        return node[2];
    }
    return extractGeminiTextNode(node[0], depth + 1, maxDepth);
};

type GeminiThought = { summary: string; content: string; chunks: string[]; finished: boolean };
type ParsedGeminiMessage = { role: 'user' | 'assistant'; content: string; thoughts?: GeminiThought[] };

const THINKING_SECTION_REGEX = /\n\*\*([^*]+)\*\*\n/;

const findGeminiThoughtText = (candidate: unknown, depth = 0, maxDepth = 8): string | null => {
    if (typeof candidate === 'string') {
        return THINKING_SECTION_REGEX.test(candidate) ? candidate : null;
    }
    if (!Array.isArray(candidate) || depth >= maxDepth) {
        return null;
    }
    for (const entry of candidate) {
        const found = findGeminiThoughtText(entry, depth + 1, maxDepth);
        if (found) {
            return found;
        }
    }
    return null;
};

const summarizeThoughtCandidate = (assistantCandidate: unknown[]) =>
    assistantCandidate.slice(0, 12).map((entry, index) => {
        if (Array.isArray(entry)) {
            return { index, type: 'array', length: entry.length };
        }
        return { index, type: typeof entry };
    });

const parseGeminiThoughts = (assistantCandidate: unknown[]): GeminiThought[] => {
    const thinkingText = findGeminiThoughtText(assistantCandidate);
    if (typeof thinkingText !== 'string' || thinkingText.length === 0) {
        if (assistantCandidate.length >= 30) {
            logger.debug('[Blackiya/Gemini] Expected thoughts-like payload but no thought text candidate was found', {
                candidateLength: assistantCandidate.length,
                candidateSnapshot: summarizeThoughtCandidate(assistantCandidate),
            });
        }
        return [];
    }

    const thoughts: GeminiThought[] = [];
    const sections = thinkingText.split(THINKING_SECTION_REGEX);
    for (let i = 1; i < sections.length; i += 2) {
        const title = sections[i]?.trim();
        const content = sections[i + 1]?.trim();
        if (title && content) {
            thoughts.push({ summary: title, content, chunks: [], finished: true });
        }
    }
    return thoughts;
};

const parseGeminiUserMessage = (conversationRoot: unknown[]): ParsedGeminiMessage | null => {
    const userSlot = conversationRoot[2];
    if (!Array.isArray(userSlot)) {
        return null;
    }
    const rawUserContent = extractGeminiTextNode(userSlot);
    if (!rawUserContent) {
        return null;
    }
    return { role: 'user', content: rawUserContent };
};

const resolveGeminiAssistantCandidate = (conversationRoot: unknown[], isStreamFormat: boolean): unknown[] | null => {
    const assistantSlot = isStreamFormat ? conversationRoot[4] : conversationRoot[3];
    if (isStreamFormat) {
        if (Array.isArray(assistantSlot) && Array.isArray(assistantSlot[0])) {
            return assistantSlot[0];
        }
        return null;
    }
    if (!Array.isArray(assistantSlot)) {
        return null;
    }
    const nested = assistantSlot[0];
    if (!Array.isArray(nested) || !Array.isArray(nested[0])) {
        return null;
    }
    return nested[0];
};

const parseGeminiAssistantMessage = (
    conversationRoot: unknown[],
    isStreamFormat: boolean,
): ParsedGeminiMessage | null => {
    const assistantCandidate = resolveGeminiAssistantCandidate(conversationRoot, isStreamFormat);
    if (!assistantCandidate) {
        return null;
    }
    const textParts = assistantCandidate[1];
    const assistantContent = Array.isArray(textParts) && typeof textParts[0] === 'string' ? textParts[0] : '';
    const thoughts = parseGeminiThoughts(assistantCandidate);
    if (!assistantContent && thoughts.length === 0) {
        return null;
    }
    return {
        role: 'assistant',
        content: assistantContent,
        thoughts: thoughts.length > 0 ? thoughts : undefined,
    };
};

export const parseGeminiMessages = (conversationRoot: unknown, isStreamFormat: boolean): ParsedGeminiMessage[] => {
    if (!Array.isArray(conversationRoot)) {
        return [];
    }
    const parsedMessages: ParsedGeminiMessage[] = [];

    if (!isStreamFormat) {
        const userMessage = parseGeminiUserMessage(conversationRoot);
        if (userMessage) {
            parsedMessages.push(userMessage);
        }
    }

    const assistantMessage = parseGeminiAssistantMessage(conversationRoot, isStreamFormat);
    if (assistantMessage) {
        parsedMessages.push(assistantMessage);
    }

    return parsedMessages;
};

export const extractGeminiModelName = (conversationRoot: unknown, isStreamFormat: boolean): string => {
    const defaultModelName = 'gemini-2.0';
    if (!Array.isArray(conversationRoot)) {
        return defaultModelName;
    }
    const modelSlotSource = isStreamFormat ? conversationRoot[4] : conversationRoot[3];
    if (!Array.isArray(modelSlotSource) || modelSlotSource.length <= 21) {
        return defaultModelName;
    }
    const modelSlug = modelSlotSource[21];
    if (typeof modelSlug !== 'string') {
        return defaultModelName;
    }
    const modelName = `gemini-${modelSlug.toLowerCase().replace(/\s+/g, '-')}`;
    logger.debug('[Blackiya/Gemini] Extracted model name:', modelName);
    return modelName;
};

const buildGeminiConversationMapping = (
    parsedMessages: ParsedGeminiMessage[],
    now: number,
): Record<string, MessageNode> => {
    const mapping: Record<string, MessageNode> = {};
    parsedMessages.forEach((msg, index) => {
        const id = `segment-${index}`;
        mapping[id] = {
            id,
            message: {
                id,
                author: { role: msg.role, name: msg.role === 'user' ? 'User' : 'Gemini', metadata: {} },
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
};

const buildGeminiConversationData = (
    conversationId: string | null,
    conversationTitle: string,
    mapping: Record<string, MessageNode>,
    modelName: string,
    now: number,
): ConversationData => {
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
};

export const parseConversationPayload = (
    payload: unknown,
    titlesCache: LRUCache<string, string>,
    activeConvos: LRUCache<string, ConversationData>,
): ConversationData | null => {
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
    const now = Date.now() / 1000;
    const mapping = buildGeminiConversationMapping(parsedMessages, now);
    const modelName = extractGeminiModelName(conversationRoot, isStreamFormat);

    logger.info('[Blackiya/Gemini] Successfully parsed conversation with', Object.keys(mapping).length, 'messages');

    const conversationData = buildGeminiConversationData(conversationId, conversationTitle, mapping, modelName, now);
    if (conversationId) {
        activeConvos.set(conversationId, conversationData);
    }
    return conversationData;
};

export const evaluateGeminiReadiness = (data: ConversationData): PlatformReadiness => {
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
};
