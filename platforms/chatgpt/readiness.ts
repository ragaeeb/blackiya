/**
 * ChatGPT readiness evaluation.
 *
 * Determines whether a captured `ConversationData` snapshot is ready for
 * canonical export by inspecting assistant message state.
 *
 * @module platforms/chatgpt/readiness
 */

import type { PlatformReadiness } from '@/platforms/types';
import { hashText } from '@/utils/hash';
import type { ConversationData, Message, MessageNode } from '@/utils/types';
import { normalizeNumber, normalizeText } from './utils';

const getMessageTimestamp = (message: Message): number =>
    normalizeNumber(message.update_time) ?? normalizeNumber(message.create_time) ?? 0;

const collectAssistantMessages = (mapping: Record<string, MessageNode>): Message[] => {
    const assistantMessages = Object.values(mapping)
        .map((node) => node.message)
        .filter((message): message is NonNullable<typeof message> => !!message && message.author.role === 'assistant');
    assistantMessages.sort((a, b) => getMessageTimestamp(a) - getMessageTimestamp(b));
    return assistantMessages;
};

/**
 * Extracts the plaintext content from an assistant message by joining parts
 * and falling back to the `content` field if present.
 */
export const extractAssistantText = (message: Message): string => {
    const partsText = Array.isArray(message.content.parts)
        ? message.content.parts.filter((part): part is string => typeof part === 'string').join('')
        : '';
    const contentText = normalizeText(message.content.content) ?? '';
    return [partsText, contentText]
        .filter((value) => value.length > 0)
        .join('\n')
        .trim()
        .normalize('NFC');
};

const hasFinishedAssistantText = (message: Message): boolean =>
    message.status === 'finished_successfully' &&
    message.content.content_type === 'text' &&
    extractAssistantText(message).length > 0;

/**
 * Evaluates whether a ChatGPT conversation snapshot is ready for canonical export.
 *
 * Readiness requires:
 * - At least one assistant message exists
 * - No assistant message is still `in_progress`
 * - The latest finished text message has `end_turn === true`
 */
export const evaluateChatGPTReadiness = (data: ConversationData): PlatformReadiness => {
    const assistantMessages = collectAssistantMessages(data.mapping);

    if (assistantMessages.length === 0) {
        return {
            ready: false,
            terminal: false,
            reason: 'assistant-missing',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    const terminal = !assistantMessages.some((message) => message.status === 'in_progress');
    if (!terminal) {
        return {
            ready: false,
            terminal: false,
            reason: 'assistant-in-progress',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    const finishedTextMessages = assistantMessages.filter(hasFinishedAssistantText);
    const latestFinishedText = finishedTextMessages[finishedTextMessages.length - 1];

    if (!latestFinishedText) {
        return {
            ready: false,
            terminal: true,
            reason: 'assistant-text-missing',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    if (latestFinishedText.end_turn !== true) {
        return {
            ready: false,
            terminal: true,
            reason: 'assistant-latest-text-not-terminal-turn',
            contentHash: null,
            latestAssistantTextLength: extractAssistantText(latestFinishedText).length,
        };
    }

    const latestText = extractAssistantText(latestFinishedText);
    return {
        ready: true,
        terminal: true,
        reason: 'terminal',
        contentHash: latestText.length > 0 ? hashText(latestText) : null,
        latestAssistantTextLength: latestText.length,
    };
};
