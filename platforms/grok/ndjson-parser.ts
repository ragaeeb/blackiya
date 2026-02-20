import { logger } from '@/utils/logger';
import type { ConversationData, Message, MessageContent } from '@/utils/types';
import {
    attachGrokComNodeToParent,
    getOrCreateGrokComConversation,
    hasGrokComMessages,
    parseGrokComResponses,
} from './grok-com-parser';
import { grokState } from './state';
import {
    extractGrokComConversationIdFromUrl,
    GROK_COM_CONVERSATION_ID_PATTERN,
    X_CONVERSATION_ID_PATTERN,
} from './url-utils';

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

const hasSupportedConversationIdShape = (value: unknown): value is string =>
    typeof value === 'string' &&
    (GROK_COM_CONVERSATION_ID_PATTERN.test(value) || X_CONVERSATION_ID_PATTERN.test(value));

const extractConversationIdFromParsedLine = (parsed: any): string | null => {
    const direct = parsed?.conversationId;
    if (hasSupportedConversationIdShape(direct)) {
        return direct;
    }
    const nested = parsed?.result?.conversation?.conversationId;
    if (hasSupportedConversationIdShape(nested)) {
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

const createThoughtEntries = (
    reasoningChunks: string[],
): Array<{
    summary: string;
    content: string;
    chunks: string[];
    finished: boolean;
}> =>
    reasoningChunks.map((text) => ({
        summary: text,
        content: text,
        chunks: [],
        finished: true,
    }));

const buildAddResponseContent = (finalText: string, reasoningChunks: string[]): MessageContent => {
    if (reasoningChunks.length === 0) {
        return { content_type: 'text', parts: finalText ? [finalText] : [] };
    }

    const thoughts = createThoughtEntries(reasoningChunks);
    if (!finalText) {
        return { content_type: 'thoughts', thoughts, parts: [] };
    }

    return { content_type: 'text', parts: [finalText], thoughts };
};

const extractAddResponseModelSlug = (line: any): string | null => {
    const result = line?.result;
    const candidates = [
        result?.model,
        result?.modelSlug,
        result?.model_slug,
        result?.uiLayout?.steerModelId,
        result?.ui_layout?.steerModelId,
        result?.uiLayout?.modelId,
        result?.messageMetadata?.model,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }
    return null;
};

const ensureRootNode = (conversation: ConversationData, rootId: string) => {
    if (!conversation.mapping[rootId]) {
        conversation.mapping[rootId] = { id: rootId, message: null, parent: null, children: [] };
    }
};

const resolveAddResponseSeed = (
    parsedLines: any[],
): {
    userChatItemId: string | null;
    assistantChatItemId: string | null;
} => {
    const seed = parsedLines.find((line) => typeof line?.conversationId === 'string') ?? {};
    return {
        userChatItemId: typeof seed?.userChatItemId === 'string' ? seed.userChatItemId : null,
        assistantChatItemId: typeof seed?.agentChatItemId === 'string' ? seed.agentChatItemId : null,
    };
};

type AddResponseStreamState = {
    assistantChatItemId: string | null;
    finalTextTokens: string[];
    reasoningChunks: string[];
    sawSoftStop: boolean;
    resolvedModelSlug: string | null;
};

const collectAddResponseStreamState = (
    parsedLines: any[],
    initialAssistantChatItemId: string | null,
): AddResponseStreamState => {
    const state: AddResponseStreamState = {
        assistantChatItemId: initialAssistantChatItemId,
        finalTextTokens: [],
        reasoningChunks: [],
        sawSoftStop: false,
        resolvedModelSlug: null,
    };

    for (const line of parsedLines) {
        const result = line?.result;
        if (!result || typeof result !== 'object') {
            continue;
        }

        if (typeof result.responseChatItemId === 'string') {
            state.assistantChatItemId = result.responseChatItemId;
        }

        if (typeof result.message === 'string') {
            if (result.isThinking) {
                state.reasoningChunks.push(result.message);
            } else {
                state.finalTextTokens.push(result.message);
            }
        }

        state.sawSoftStop = state.sawSoftStop || result.isSoftStop === true;
        if (!state.resolvedModelSlug) {
            state.resolvedModelSlug = extractAddResponseModelSlug(line);
        }
    }

    return state;
};

const hasAddResponseContent = (finalText: string, reasoningChunks: string[]): boolean =>
    finalText.length > 0 || reasoningChunks.length > 0;

const ensureNode = (conversation: ConversationData, nodeId: string, parentId: string) => {
    if (!conversation.mapping[nodeId]) {
        conversation.mapping[nodeId] = {
            id: nodeId,
            message: null,
            parent: parentId,
            children: [],
        };
    }
};

const buildAssistantMessageFromAddResponse = (
    assistantNodeId: string,
    finalText: string,
    reasoningChunks: string[],
    sawSoftStop: boolean,
    modelSlug: string | null,
    createdAtSeconds: number,
): Message => ({
    id: assistantNodeId,
    author: { role: 'assistant', name: 'Grok', metadata: {} },
    create_time: createdAtSeconds,
    update_time: null,
    content: buildAddResponseContent(finalText, reasoningChunks),
    status: sawSoftStop ? 'finished_successfully' : 'in_progress',
    end_turn: sawSoftStop,
    weight: 1,
    metadata: {
        sender: 'assistant',
        partial: !sawSoftStop,
        model: modelSlug,
    },
    recipient: 'all',
    channel: null,
});

const parseXAddResponseNdjson = (parsedLines: any[], conversationId: string): ConversationData | null => {
    const conversation = getOrCreateGrokComConversation(conversationId);
    const rootId = `grok-com-root-${conversationId}`;
    ensureRootNode(conversation, rootId);

    const seed = resolveAddResponseSeed(parsedLines);
    const state = collectAddResponseStreamState(parsedLines, seed.assistantChatItemId);
    if (!state.assistantChatItemId) {
        return null;
    }

    const finalText = state.finalTextTokens.join('');
    if (!hasAddResponseContent(finalText, state.reasoningChunks)) {
        return null;
    }

    const createdAtSeconds = Date.now() / 1000;
    const assistantNodeId = state.assistantChatItemId;
    const parentId = seed.userChatItemId ?? rootId;

    ensureNode(conversation, assistantNodeId, parentId);
    ensureNode(conversation, parentId, rootId);
    attachGrokComNodeToParent(conversation, assistantNodeId, parentId, rootId);

    conversation.mapping[assistantNodeId].message = buildAssistantMessageFromAddResponse(
        assistantNodeId,
        finalText,
        state.reasoningChunks,
        state.sawSoftStop,
        state.resolvedModelSlug,
        createdAtSeconds,
    );

    conversation.current_node = assistantNodeId;
    conversation.update_time = Math.max(conversation.update_time, createdAtSeconds);
    if (state.resolvedModelSlug) {
        conversation.default_model_slug = state.resolvedModelSlug;
    }
    return conversation;
};

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

    if (url.includes('/2/grok/add_response.json')) {
        return parseXAddResponseNdjson(parsedLines, conversationId);
    }

    return parseNdjsonConversation(parsedLines, conversationId);
};
