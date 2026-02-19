/**
 * ChatGPT SSE stream parser.
 *
 * Extracts structured `ConversationData` from raw SSE (Server-Sent Events) text
 * produced by the ChatGPT streaming API (`/backend-api/f/conversation`).
 *
 * @module platforms/chatgpt/sse-parser
 */

import type { ConversationData, Message, MessageNode } from '@/utils/types';
import {
    getConversationCandidate,
    normalizeConversationCandidate,
    resolveConversationTitle,
} from './conversation-normalizer';
import { normalizeMessage } from './message-normalizer';
import {
    CONVERSATION_ID_PATTERN,
    isRecord,
    normalizeModelSlug,
    normalizeNumber,
    normalizeText,
    tryParseJson,
} from './utils';

// SSE block extraction

/**
 * Splits raw SSE text into parsed JSON payloads.
 * Skips `[DONE]` sentinel and non-JSON lines.
 */
export const extractSsePayloads = (text: string): unknown[] => {
    if (!text.includes('data:')) {
        return [];
    }

    const payloads: unknown[] = [];
    const blocks = text.split(/\r?\n\r?\n/);

    for (const block of blocks) {
        const joined = block
            .split(/\r?\n/)
            .map((line) => line.match(/^\s*data:\s?(.*)$/)?.[1] ?? null)
            .filter((line): line is string => typeof line === 'string')
            .join('\n')
            .trim();

        if (!joined || joined === '[DONE]') {
            continue;
        }

        const parsed = tryParseJson(joined);
        if (parsed !== null) {
            payloads.push(parsed);
        }
    }

    return payloads;
};

// Per-event helpers used while building a synthetic conversation

const extractConversationIdFromEvent = (event: Record<string, unknown>): string | null => {
    const candidates = [
        event.conversation_id,
        event.conversationId,
        isRecord(event.conversation) ? event.conversation.id : null,
        isRecord(event.message) ? (event.message as Record<string, unknown>).conversation_id : null,
        isRecord(event.message) ? (event.message as Record<string, unknown>).conversationId : null,
    ];

    for (const candidate of candidates) {
        const normalized = normalizeText(candidate);
        if (normalized && CONVERSATION_ID_PATTERN.test(normalized)) {
            return normalized;
        }
    }
    return null;
};

const updateMessageTiming = (message: Message, stats: { create: number; update: number }): void => {
    const messageCreate = normalizeNumber(message.create_time);
    const messageUpdate = normalizeNumber(message.update_time);
    if (messageCreate !== null) {
        stats.create = Math.min(stats.create, messageCreate);
        stats.update = Math.max(stats.update, messageCreate);
    }
    if (messageUpdate !== null) {
        stats.update = Math.max(stats.update, messageUpdate);
    }
};

const extractMessageModelSlug = (message: Message): string | null =>
    normalizeModelSlug(message.metadata.resolved_model_slug) ||
    normalizeModelSlug(message.metadata.model_slug) ||
    normalizeModelSlug(message.metadata.model);

const appendMessageToMapping = (
    mapping: Record<string, MessageNode>,
    previousId: string,
    messageId: string,
    message: Message,
): string => {
    mapping[messageId] = { id: messageId, message, parent: previousId, children: [] };
    mapping[previousId]?.children.push(messageId);
    return messageId;
};

// Multi-payload SSE collection

type SseCollectionResult =
    | { directConversation: ConversationData }
    | {
          directConversation: null;
          conversationId: string | null;
          title: string;
          messageOrder: string[];
          messagesById: Map<string, Message>;
      };

/**
 * Iterates SSE payloads to either find an embedded full conversation object
 * or accumulate individual messages for later assembly.
 */
const collectSseMessages = (payloads: unknown[]): SseCollectionResult => {
    let conversationId: string | null = null;
    let title = '';
    const messageOrder: string[] = [];
    const messagesById = new Map<string, Message>();

    for (const payload of payloads) {
        const directConversation = normalizeConversationCandidate(getConversationCandidate(payload));
        if (directConversation) {
            return { directConversation };
        }

        if (!isRecord(payload)) {
            continue;
        }

        if (!conversationId) {
            conversationId = extractConversationIdFromEvent(payload);
        }
        if (!title) {
            title = normalizeText(payload.conversation_title) ?? normalizeText(payload.title) ?? '';
        }

        const normalizedMessage = normalizeMessage(payload.message);
        if (!normalizedMessage) {
            continue;
        }

        if (!messagesById.has(normalizedMessage.id)) {
            messageOrder.push(normalizedMessage.id);
        }
        messagesById.set(normalizedMessage.id, normalizedMessage);
    }

    return { directConversation: null, conversationId, title, messageOrder, messagesById };
};

// Public: build ConversationData from SSE payload list

/**
 * Builds a synthetic `ConversationData` from a list of parsed SSE event payloads.
 *
 * Returns null when no conversation id or messages could be extracted.
 */
export const buildConversationFromSsePayloads = (payloads: unknown[]): ConversationData | null => {
    const collected = collectSseMessages(payloads);
    if (collected.directConversation) {
        return collected.directConversation;
    }

    const { conversationId, title, messageOrder, messagesById } = collected;
    if (!conversationId || messageOrder.length === 0) {
        return null;
    }

    const mapping: Record<string, MessageNode> = {
        root: { id: 'root', message: null, parent: null, children: [] },
    };

    let previousId = 'root';
    const timing = { create: Number.POSITIVE_INFINITY, update: 0 };
    let modelSlug: string | null = null;

    for (const messageId of messageOrder) {
        const message = messagesById.get(messageId);
        if (!message) {
            continue;
        }

        previousId = appendMessageToMapping(mapping, previousId, messageId, message);
        updateMessageTiming(message, timing);
        const messageModel = extractMessageModelSlug(message);
        if (messageModel) {
            modelSlug = messageModel;
        }
    }

    const now = Math.floor(Date.now() / 1000);
    const normalizedCreate = Number.isFinite(timing.create) ? timing.create : now;
    const normalizedUpdate = timing.update > 0 ? timing.update : normalizedCreate;

    return {
        title: resolveConversationTitle(title, mapping),
        create_time: normalizedCreate,
        update_time: normalizedUpdate,
        mapping,
        conversation_id: conversationId,
        current_node: previousId,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: modelSlug ?? 'unknown',
        safe_urls: [],
        blocked_urls: [],
    };
};
