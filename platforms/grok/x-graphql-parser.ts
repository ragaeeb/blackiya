import { logger } from '@/utils/logger';
import type { Author, ConversationData, Message, MessageContent, MessageNode } from '@/utils/types';
import { DEFAULT_GROK_MODEL_SLUG } from './constants';
import { grokState } from './state';

export const extractThinkingContent = (chatItem: any): any[] | undefined => {
    if (!Array.isArray(chatItem?.deepsearch_headers)) {
        return undefined;
    }
    const thoughts = chatItem.deepsearch_headers.flatMap((header: any) =>
        Array.isArray(header?.steps)
            ? header.steps
                  .filter((step: any) => step?.final_message)
                  .map((step: any) => ({
                      summary: header.header || 'Reasoning',
                      content: step.final_message,
                      chunks: [],
                      finished: true,
                  }))
            : [],
    );
    return thoughts.length > 0 ? thoughts : undefined;
};

const createAuthor = (senderType: string): Author => ({
    role: senderType === 'User' ? 'user' : 'assistant',
    name: senderType === 'User' ? 'User' : 'Grok',
    metadata: {},
});

const extractModelSlug = (item: any): string | null => {
    const candidates = [item?.model, item?.model_slug, item?.modelSlug, item?.model_name, item?.metadata?.model];
    for (const candidate of candidates) {
        if (typeof candidate === 'string') {
            const trimmed = candidate.trim();
            if (trimmed.length > 0) {
                return trimmed;
            }
        }
    }
    return null;
};

export const parseGrokItem = (item: any) => {
    const chatItemId = item?.chat_item_id;
    if (!chatItemId) {
        return null;
    }

    const createdAtMs = item?.created_at_ms;
    const grokMode = item?.grok_mode || 'Normal';
    const messageText = item?.message || '';
    const senderType = item?.sender_type || 'Agent';
    const isPartial = item?.is_partial || false;
    const thoughts = extractThinkingContent(item);
    const modelSlug = extractModelSlug(item);

    const content: MessageContent = {
        content_type: thoughts ? 'thoughts' : 'text',
        parts: [messageText],
        thoughts,
    };

    const messageObj: Message = {
        id: chatItemId,
        author: createAuthor(senderType),
        create_time: createdAtMs ? createdAtMs / 1000 : null,
        update_time: null,
        content,
        status: isPartial ? 'in_progress' : 'finished_successfully',
        end_turn: !isPartial,
        weight: 1,
        metadata: {
            grok_mode: grokMode,
            sender_type: senderType,
            is_partial: isPartial,
            model: modelSlug ?? null,
            thinking_trace: item?.thinking_trace || '',
            ui_layout: item?.ui_layout || {},
        },
        recipient: 'all',
        channel: null,
    };

    return { chatItemId, createdAtMs, senderType, messageText, modelSlug, messageObj };
};

const getConversationId = (conversationIdOverride: string | undefined, chatItemId: string | undefined) =>
    conversationIdOverride || chatItemId || '';

const getTitleFromFirstItem = (conversationId: string, senderType: string, messageText: string): string | null => {
    if (senderType !== 'User' || !messageText || grokState.conversationTitles.has(conversationId)) {
        return null;
    }
    const firstLine = messageText.split('\n')[0];
    if (!firstLine || firstLine.length >= 100) {
        return null;
    }
    return firstLine;
};

const createGrokRootNode = (): MessageNode => ({
    id: 'grok-root',
    message: null,
    parent: null,
    children: [],
});

type ConversationBuildState = {
    mapping: Record<string, MessageNode>;
    rootId: string;
    previousNodeId: string;
    conversationId: string;
    conversationTitle: string;
    modelSlug: string;
    createTime: number;
    updateTime: number;
};

const updateConversationFromItem = (
    state: ConversationBuildState,
    parsedItem: NonNullable<ReturnType<typeof parseGrokItem>>,
    index: number,
    conversationIdOverride?: string,
): void => {
    if (index === 0) {
        state.conversationId = getConversationId(conversationIdOverride, parsedItem.chatItemId);
        const titleCandidate = getTitleFromFirstItem(
            state.conversationId,
            parsedItem.senderType,
            parsedItem.messageText,
        );
        if (titleCandidate) {
            state.conversationTitle = titleCandidate;
        }
    }

    if (parsedItem.createdAtMs) {
        const timestamp = parsedItem.createdAtMs / 1000;
        if (index === 0) {
            state.createTime = timestamp;
        }
        state.updateTime = Math.max(state.updateTime, timestamp);
    }

    if (parsedItem.modelSlug) {
        state.modelSlug = parsedItem.modelSlug;
    }

    state.mapping[parsedItem.chatItemId] = {
        id: parsedItem.chatItemId,
        message: parsedItem.messageObj,
        parent: state.previousNodeId,
        children: [],
    };

    const parentNode = state.mapping[state.previousNodeId];
    if (parentNode) {
        parentNode.children.push(parsedItem.chatItemId);
    }
    state.previousNodeId = parsedItem.chatItemId;
};

// ── GraphQL conversation parser ────────────────────────────────────────────────

/**
 * Parse a GrokConversationItemsByRestId GraphQL response into ConversationData.
 * `conversationIdOverride` is supplied when the ID can be read from the request URL.
 */
export const parseGrokResponse = (data: any, conversationIdOverride?: string): ConversationData | null => {
    try {
        const conversationData = data?.data?.grok_conversation_items_by_rest_id;
        if (!conversationData) {
            logger.info('[Blackiya/Grok] No conversation data found in response');
            return null;
        }

        const items = conversationData.items;
        if (!Array.isArray(items) || items.length === 0) {
            logger.info('[Blackiya/Grok] No conversation items found');
            return null;
        }

        const rootNode = createGrokRootNode();
        const state: ConversationBuildState = {
            mapping: { [rootNode.id]: rootNode },
            rootId: rootNode.id,
            previousNodeId: rootNode.id,
            conversationId: '',
            conversationTitle: 'Grok Conversation',
            modelSlug: DEFAULT_GROK_MODEL_SLUG,
            createTime: Date.now() / 1000,
            updateTime: Date.now() / 1000,
        };

        for (let i = 0; i < items.length; i++) {
            const parsedItem = parseGrokItem(items[i]);
            if (parsedItem) {
                updateConversationFromItem(state, parsedItem, i, conversationIdOverride);
            }
        }

        const { conversationId, mapping } = state;
        let { conversationTitle, createTime, updateTime } = state;

        // Apply cached title if available
        if (conversationId && grokState.conversationTitles.has(conversationId)) {
            conversationTitle = grokState.conversationTitles.get(conversationId)!;
            logger.info('[Blackiya/Grok] Using cached title:', conversationTitle);
        }

        const lastNodeId =
            typeof state.previousNodeId === 'string' && state.previousNodeId.length > 0 && mapping[state.previousNodeId]
                ? state.previousNodeId
                : rootNode.id;

        const result: ConversationData = {
            title: conversationTitle,
            create_time: createTime,
            update_time: updateTime,
            mapping,
            conversation_id: conversationId,
            current_node: lastNodeId,
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: state.modelSlug,
            safe_urls: [],
            blocked_urls: [],
        };

        if (conversationId) {
            grokState.activeConversations.set(conversationId, result);
        }
        logger.info('[Blackiya/Grok] Successfully parsed conversation with', Object.keys(mapping).length, 'nodes');
        return result;
    } catch (e) {
        logger.error('[Blackiya/Grok] Failed to parse conversation:', e);
        if (e instanceof Error) {
            logger.error('[Blackiya/Grok] Error stack:', e.stack);
        }
        return null;
    }
};
