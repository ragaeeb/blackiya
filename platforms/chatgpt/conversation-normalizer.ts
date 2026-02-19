/**
 * ChatGPT conversation-level normalization.
 *
 * Converts raw API payloads (JSON object or wrapped shapes) into typed
 * `ConversationData` objects ready for export.
 *
 * @module platforms/chatgpt/conversation-normalizer
 */

import type { ConversationData, Message, MessageNode } from '@/utils/types';
import {
    CONVERSATION_ID_PATTERN,
    isPlaceholderTitle,
    isRecord,
    normalizeModelSlug,
    normalizeNumber,
    normalizeText,
} from './utils';

// ---------------------------------------------------------------------------
// Conversation ID helpers
// ---------------------------------------------------------------------------

export const normalizeConversationId = (candidate: Record<string, unknown>): string | null => {
    const conversationId = normalizeText(candidate.conversation_id) ?? normalizeText(candidate.id);
    if (!conversationId || !CONVERSATION_ID_PATTERN.test(conversationId)) {
        return null;
    }
    return conversationId;
};

/**
 * Unwraps common envelope shapes:
 *   { conversation: { ... } }
 *   { data: { conversation: { ... } } }
 */
export const getConversationCandidate = (parsed: unknown): unknown => {
    if (!isRecord(parsed)) {
        return parsed;
    }
    if (isRecord(parsed.conversation)) {
        return parsed.conversation;
    }
    if (isRecord(parsed.data) && isRecord((parsed.data as Record<string, unknown>).conversation)) {
        return (parsed.data as Record<string, unknown>).conversation;
    }
    return parsed;
};

// ---------------------------------------------------------------------------
// Mapping-level extraction helpers
// ---------------------------------------------------------------------------

export const extractMappingModelSlug = (mapping: Record<string, MessageNode>): string | null => {
    for (const node of Object.values(mapping)) {
        const metadata = node.message?.metadata;
        if (!metadata) {
            continue;
        }
        const resolved =
            normalizeModelSlug(metadata.resolved_model_slug) ||
            normalizeModelSlug(metadata.model_slug) ||
            normalizeModelSlug(metadata.model);
        if (resolved) {
            return resolved;
        }
    }
    return null;
};

/** Picks the node id with the latest message timestamp as a current-node fallback. */
export const deriveCurrentNode = (mapping: Record<string, MessageNode>): string => {
    let bestNodeId = 'root';
    let bestTime = -1;

    for (const [id, node] of Object.entries(mapping)) {
        const message = node.message;
        if (!message) {
            continue;
        }
        const messageTime = normalizeNumber(message.update_time) ?? normalizeNumber(message.create_time) ?? 0;
        if (messageTime >= bestTime) {
            bestNodeId = id;
            bestTime = messageTime;
        }
    }

    return bestNodeId;
};

export const deriveConversationTimes = (mapping: Record<string, MessageNode>): { create: number; update: number } => {
    let create = Number.POSITIVE_INFINITY;
    let update = 0;

    for (const node of Object.values(mapping)) {
        const message = node.message;
        if (!message) {
            continue;
        }
        const createTime = normalizeNumber(message.create_time);
        const updateTime = normalizeNumber(message.update_time);
        if (createTime !== null) {
            create = Math.min(create, createTime);
            update = Math.max(update, createTime);
        }
        if (updateTime !== null) {
            update = Math.max(update, updateTime);
        }
    }

    const now = Math.floor(Date.now() / 1000);
    const normalizedCreate = Number.isFinite(create) ? create : now;
    const normalizedUpdate = update > 0 ? update : normalizedCreate;
    return { create: normalizedCreate, update: normalizedUpdate };
};

// ---------------------------------------------------------------------------
// Title helpers
// ---------------------------------------------------------------------------

/**
 * Derives a title from the first user message in the mapping (max 80 chars).
 * Returns empty string when no usable user message exists.
 */
export const deriveTitleFromFirstUserMessage = (mapping: Record<string, MessageNode>): string => {
    const userMessage = Object.values(mapping)
        .map((node) => node.message)
        .find((message): message is Message => !!message && message.author.role === 'user');

    if (!userMessage) {
        return '';
    }

    const raw = (userMessage.content.parts ?? [])
        .filter((part): part is string => typeof part === 'string')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!raw) {
        return '';
    }

    const maxLength = 80;
    return raw.length <= maxLength ? raw : `${raw.slice(0, maxLength - 3).trim()}...`;
};

/**
 * Returns the given title unless it is a placeholder, in which case it tries
 * to derive a title from the first user message.
 */
export const resolveConversationTitle = (title: unknown, mapping: Record<string, MessageNode>): string => {
    const normalized = normalizeText(title) ?? '';
    if (!isPlaceholderTitle(normalized)) {
        return normalized;
    }
    const derived = deriveTitleFromFirstUserMessage(mapping);
    return derived || normalized;
};

// ---------------------------------------------------------------------------
// Top-level conversation normalizer
// ---------------------------------------------------------------------------

/**
 * Attempts to parse an unknown payload into a valid `ConversationData`.
 * Returns null if the payload is missing required fields or has an invalid conversation id.
 */
export const normalizeConversationCandidate = (candidate: unknown): ConversationData | null => {
    if (!isRecord(candidate)) {
        return null;
    }

    const mappingValue = candidate.mapping;
    if (!isRecord(mappingValue)) {
        return null;
    }

    const conversationId = normalizeConversationId(candidate);
    if (!conversationId) {
        return null;
    }

    const mapping = { ...(mappingValue as Record<string, MessageNode>) };
    if (!mapping.root) {
        mapping.root = { id: 'root', message: null, parent: null, children: [] };
    }

    const times = deriveConversationTimes(mapping);
    const currentNodeCandidate = normalizeText(candidate.current_node);
    const currentNode =
        currentNodeCandidate && mapping[currentNodeCandidate] ? currentNodeCandidate : deriveCurrentNode(mapping);

    return {
        title: resolveConversationTitle(candidate.title, mapping),
        create_time: normalizeNumber(candidate.create_time) ?? times.create,
        update_time: normalizeNumber(candidate.update_time) ?? times.update,
        mapping,
        conversation_id: conversationId,
        current_node: currentNode,
        moderation_results: Array.isArray(candidate.moderation_results) ? candidate.moderation_results : [],
        plugin_ids: Array.isArray(candidate.plugin_ids)
            ? candidate.plugin_ids.filter((item): item is string => typeof item === 'string')
            : null,
        gizmo_id: normalizeText(candidate.gizmo_id),
        gizmo_type: normalizeText(candidate.gizmo_type),
        is_archived: candidate.is_archived === true,
        default_model_slug:
            normalizeModelSlug(candidate.default_model_slug) ?? extractMappingModelSlug(mapping) ?? 'unknown',
        safe_urls: Array.isArray(candidate.safe_urls)
            ? candidate.safe_urls.filter((item): item is string => typeof item === 'string')
            : [],
        blocked_urls: Array.isArray(candidate.blocked_urls)
            ? candidate.blocked_urls.filter((item): item is string => typeof item === 'string')
            : [],
    };
};
