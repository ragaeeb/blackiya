/**
 * ChatGPT message-level normalizers.
 *
 * Converts raw API/SSE message payloads into typed `Message` objects.
 *
 * @module platforms/chatgpt/message-normalizer
 */

import type { Message, MessageContent } from '@/utils/types';
import { isRecord, normalizeNumber, normalizeText } from './utils';

export const normalizeContentType = (value: unknown): MessageContent['content_type'] => {
    switch (value) {
        case 'thoughts':
        case 'reasoning_recap':
        case 'code':
        case 'execution_output':
            return value;
        default:
            return 'text';
    }
};

export const normalizeAuthorRole = (value: unknown): 'system' | 'user' | 'assistant' | 'tool' => {
    if (value === 'system' || value === 'user' || value === 'assistant' || value === 'tool') {
        return value;
    }
    return 'assistant';
};

export const normalizeMessageContent = (value: unknown): MessageContent => {
    if (!isRecord(value)) {
        return { content_type: 'text', parts: [] };
    }

    const contentType = normalizeContentType(value.content_type);
    const parts = Array.isArray(value.parts)
        ? value.parts.filter((part): part is string => typeof part === 'string')
        : [];

    const thoughts = Array.isArray(value.thoughts)
        ? value.thoughts
              .filter((thought) => isRecord(thought))
              .map((thought) => ({
                  summary: normalizeText(thought.summary) ?? '',
                  content: normalizeText(thought.content) ?? '',
                  chunks: Array.isArray(thought.chunks)
                      ? thought.chunks.filter((chunk): chunk is string => typeof chunk === 'string')
                      : [],
                  finished: thought.finished === true,
              }))
        : undefined;

    return {
        content_type: contentType,
        parts: parts.length > 0 ? parts : undefined,
        thoughts,
        content: normalizeText(value.content) ?? undefined,
    };
};

/**
 * Parses a raw message object from a ChatGPT API or SSE payload.
 * Returns null if the message lacks a valid id.
 */
export const normalizeMessage = (rawMessage: unknown): Message | null => {
    if (!isRecord(rawMessage)) {
        return null;
    }

    const messageId = normalizeText(rawMessage.id);
    if (!messageId) {
        return null;
    }

    const authorValue = isRecord(rawMessage.author) ? rawMessage.author : {};

    const statusRaw = normalizeText(rawMessage.status);
    const status: Message['status'] =
        statusRaw === 'in_progress' || statusRaw === 'error' ? statusRaw : 'finished_successfully';

    const endTurn = typeof rawMessage.end_turn === 'boolean' ? rawMessage.end_turn : null;
    const weight = normalizeNumber(rawMessage.weight) ?? 1;

    return {
        id: messageId,
        author: {
            role: normalizeAuthorRole(authorValue.role),
            name: normalizeText(authorValue.name),
            metadata: isRecord(authorValue.metadata) ? authorValue.metadata : {},
        },
        create_time: normalizeNumber(rawMessage.create_time),
        update_time: normalizeNumber(rawMessage.update_time),
        content: normalizeMessageContent(rawMessage.content),
        status,
        end_turn: endTurn,
        weight,
        metadata: isRecord(rawMessage.metadata) ? rawMessage.metadata : {},
        recipient: normalizeText(rawMessage.recipient) ?? 'all',
        channel: normalizeText(rawMessage.channel),
    };
};
