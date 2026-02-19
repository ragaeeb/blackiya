import type { PlatformReadiness } from '@/platforms/types';
import { hashText } from '@/utils/hash';
import { logger } from '@/utils/logger';
import type { LRUCache } from '@/utils/lru-cache';
import type { ConversationData, MessageNode } from '@/utils/types';

const isConversationIdCandidate = (value: unknown): value is string =>
    typeof value === 'string' && (value.startsWith('c_') || /^[a-f0-9]+$/i.test(value));

export const hasGeminiBatchexecuteConversationShape = (payload: any): boolean => {
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

const resolveGeminiStreamShape = (payload: any): StreamShapeIndices | null => {
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

export const hasGeminiStreamGenerateConversationShape = (payload: any): boolean => !!resolveGeminiStreamShape(payload);

type ConversationEnvelope = { conversationRoot: any[]; isStreamFormat: boolean };

export const resolveGeminiConversationEnvelope = (payload: any): ConversationEnvelope | null => {
    const batchexecuteRoot = payload?.[0]?.[0];
    if (Array.isArray(batchexecuteRoot)) {
        return { conversationRoot: batchexecuteRoot, isStreamFormat: false };
    }

    const streamShape = resolveGeminiStreamShape(payload);
    if (streamShape) {
        const conversationRoot = [
            null,
            payload[streamShape.idIndex],
            null,
            null,
            payload[streamShape.assistantSlotIndex],
        ];
        return { conversationRoot, isStreamFormat: true };
    }
    return null;
};

// ── Field extractors ───────────────────────────────────────────────────────────

const normalizeConversationId = (rawConversationId: unknown): string | null => {
    if (typeof rawConversationId !== 'string' || rawConversationId.length === 0) {
        return null;
    }
    return rawConversationId.startsWith('c_') ? rawConversationId.slice(2) : rawConversationId;
};

export const extractGeminiConversationId = (conversationRoot: any[], isStreamFormat: boolean): string | null => {
    const idArray = isStreamFormat ? conversationRoot[1] : conversationRoot[0];
    return normalizeConversationId(Array.isArray(idArray) ? idArray[0] : null);
};

export const resolveGeminiConversationTitle = (
    conversationId: string | null,
    titlesCache: LRUCache<string, string>,
): string =>
    conversationId && titlesCache.has(conversationId) ? titlesCache.get(conversationId)! : 'Gemini Conversation';

// ── Message parsing ────────────────────────────────────────────────────────────

const extractGeminiTextNode = (node: any): string => {
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
};

const parseGeminiThoughts = (assistantCandidate: any[]): any[] => {
    const thinkingText = assistantCandidate[37]?.[0]?.[0];
    if (typeof thinkingText !== 'string' || thinkingText.length === 0) {
        return [];
    }

    const thoughts: any[] = [];
    const sections = thinkingText.split(/\n\*\*([^*]+)\*\*\n/);
    for (let i = 1; i < sections.length; i += 2) {
        const title = sections[i]?.trim();
        const content = sections[i + 1]?.trim();
        if (title && content) {
            thoughts.push({ summary: title, content, chunks: [], finished: true });
        }
    }
    return thoughts;
};

export const parseGeminiMessages = (conversationRoot: any[], isStreamFormat: boolean): any[] => {
    const parsedMessages: any[] = [];

    if (!isStreamFormat) {
        const userSlot = conversationRoot[2];
        if (Array.isArray(userSlot)) {
            const rawUserContent = extractGeminiTextNode(userSlot);
            if (rawUserContent) {
                parsedMessages.push({ role: 'user', content: rawUserContent });
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
    const thoughts = parseGeminiThoughts(assistantCandidate);
    if (assistantContent || thoughts.length > 0) {
        parsedMessages.push({
            role: 'assistant',
            content: assistantContent,
            thoughts: thoughts.length > 0 ? thoughts : undefined,
        });
    }

    return parsedMessages;
};

export const extractGeminiModelName = (conversationRoot: any[], isStreamFormat: boolean): string => {
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
};

// ── Conversation data builder ──────────────────────────────────────────────────

const buildGeminiConversationMapping = (parsedMessages: any[]): Record<string, MessageNode> => {
    const mapping: Record<string, MessageNode> = {};
    const now = Date.now() / 1000;
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
): ConversationData => {
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
};

export const parseConversationPayload = (
    payload: any,
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
    const mapping = buildGeminiConversationMapping(parsedMessages);
    const modelName = extractGeminiModelName(conversationRoot, isStreamFormat);

    logger.info('[Blackiya/Gemini] Successfully parsed conversation with', Object.keys(mapping).length, 'messages');

    const conversationData = buildGeminiConversationData(conversationId, conversationTitle, mapping, modelName);
    if (conversationId) {
        activeConvos.set(conversationId, conversationData);
    }
    return conversationData;
};

// ── Readiness evaluation ───────────────────────────────────────────────────────

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
