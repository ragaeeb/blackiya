import type { ConversationData, MessageNode, RawConversationPayload } from '@/utils/types';
import { extractXGrokConversationId, isXGrokConversationItemsEndpoint } from './x-url-utils';

type XGrokItem = {
    chat_item_id: string;
    created_at_ms?: number;
    grok_mode?: string;
    is_partial?: boolean;
    message?: string;
    sender_type: string;
};

const parsePayload = (data: unknown): Record<string, any> | null => {
    try {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null;
    } catch {
        return null;
    }
};

const isConversationItem = (value: unknown): value is XGrokItem => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const item = value as Partial<XGrokItem>;
    return typeof item.chat_item_id === 'string' && typeof item.sender_type === 'string';
};

const roleFor = (senderType: string): 'user' | 'assistant' =>
    senderType.toLowerCase() === 'user' ? 'user' : 'assistant';

const timestampFor = (item: XGrokItem): number | null =>
    typeof item.created_at_ms === 'number' && Number.isFinite(item.created_at_ms) ? item.created_at_ms / 1000 : null;

const buildMessageNode = (item: XGrokItem, parentId: string): MessageNode => {
    const role = roleFor(item.sender_type);
    const timestamp = timestampFor(item);
    const messageText = typeof item.message === 'string' ? item.message : '';
    const isPartial = role === 'assistant' && item.is_partial === true;
    return {
        id: item.chat_item_id,
        parent: parentId,
        children: [],
        message: {
            id: item.chat_item_id,
            author: { role, name: role === 'user' ? 'User' : 'Grok', metadata: {} },
            create_time: timestamp,
            update_time: timestamp,
            content: { content_type: 'text', parts: [messageText] },
            status: isPartial ? 'in_progress' : 'finished_successfully',
            end_turn: role === 'assistant' ? !isPartial : false,
            weight: 1,
            metadata: {
                sender_type: item.sender_type,
                grok_mode: item.grok_mode ?? null,
                partial: isPartial,
            },
            recipient: 'all',
            channel: null,
        },
    };
};

type MappingResult = {
    mapping: Record<string, MessageNode>;
    currentNode: string;
    createTime: number;
    updateTime: number;
    modelSlug: string;
    firstUserText: string;
};

const buildMapping = (items: XGrokItem[], rootId: string): MappingResult => {
    const mapping: Record<string, MessageNode> = {
        [rootId]: { id: rootId, message: null, parent: null, children: [] },
    };
    let currentNode = rootId;
    let createTime = Number.POSITIVE_INFINITY;
    let updateTime = 0;
    let modelSlug = 'grok';
    let firstUserText = '';

    for (const item of items) {
        const node = buildMessageNode(item, currentNode);
        const timestamp = node.message?.create_time ?? null;
        if (timestamp !== null) {
            createTime = Math.min(createTime, timestamp);
            updateTime = Math.max(updateTime, timestamp);
        }
        modelSlug = typeof item.grok_mode === 'string' && item.grok_mode.trim() ? item.grok_mode : modelSlug;
        if (node.message?.author.role === 'user' && !firstUserText) {
            firstUserText = (node.message.content.parts?.[0] as string | undefined)?.trim() ?? '';
        }
        mapping[item.chat_item_id] = node;
        mapping[currentNode]?.children.push(item.chat_item_id);
        currentNode = item.chat_item_id;
    }
    return { mapping, currentNode, createTime, updateTime, modelSlug, firstUserText };
};

export const parseXGrokConversationItems = (data: unknown, url: string): ConversationData | null => {
    if (!isXGrokConversationItemsEndpoint(url)) {
        return null;
    }
    const conversationId = extractXGrokConversationId(url);
    const payload = parsePayload(data);
    const rawItems = payload?.data?.grok_conversation_items_by_rest_id?.items;
    if (!conversationId || !Array.isArray(rawItems)) {
        return null;
    }
    const items = rawItems.filter(isConversationItem).reverse();
    if (items.length === 0) {
        return null;
    }

    const rootId = `x-grok-root-${conversationId}`;
    const { mapping, currentNode, createTime, updateTime, modelSlug, firstUserText } = buildMapping(items, rootId);

    const now = Date.now() / 1000;
    const title = firstUserText.split('\n')[0]?.slice(0, 80).trim() || 'Grok Conversation';
    return {
        title,
        create_time: Number.isFinite(createTime) ? createTime : now,
        update_time: updateTime || now,
        mapping,
        conversation_id: conversationId,
        current_node: currentNode,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: modelSlug,
        safe_urls: [],
        blocked_urls: [],
        raw_payload: payload as RawConversationPayload,
    };
};
