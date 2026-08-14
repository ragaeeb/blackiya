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
import { normalizeText } from './utils';

type ChatGPTReadinessOptions = {
    allowInterruptedAssistant?: boolean;
};

const collectActiveBranchMessages = (data: ConversationData): Message[] => {
    if (!data.mapping[data.current_node]) {
        return [];
    }

    const messages: Message[] = [];
    const visited = new Set<string>();
    let nodeId: string | null = data.current_node;

    while (nodeId && !visited.has(nodeId)) {
        visited.add(nodeId);
        const node: MessageNode | undefined = data.mapping[nodeId];
        if (!node) {
            break;
        }
        if (node.message) {
            messages.push(node.message);
        }
        nodeId = node.parent;
    }

    return messages.reverse();
};

const collectCurrentTurnAssistantMessages = (data: ConversationData): Message[] => {
    const activeBranchMessages = collectActiveBranchMessages(data);

    let latestUserIndex = -1;
    for (let index = activeBranchMessages.length - 1; index >= 0; index -= 1) {
        if (activeBranchMessages[index]?.author.role === 'user') {
            latestUserIndex = index;
            break;
        }
    }

    return activeBranchMessages.slice(latestUserIndex + 1).filter((message) => message.author.role === 'assistant');
};

/**
 * Extracts the plaintext content from an assistant message by joining parts
 * and falling back to the `content` field if present.
 */
const extractMessageText = (message: Message): string => {
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

export const extractAssistantText = (message: Message): string => extractMessageText(message);

const hasFinishedAssistantText = (message: Message): boolean =>
    message.status === 'finished_successfully' &&
    message.content.content_type === 'text' &&
    extractAssistantText(message).length > 0;

const isTerminalNonTextAssistant = (message: Message, text: string): boolean =>
    message.status === 'finished_successfully' &&
    message.end_turn === true &&
    text.length === 0 &&
    (message.content.content_type === 'reasoning_recap' || message.content.content_type === 'thoughts');

const resolveTerminalUserOnlyReadiness = (
    activeBranchMessages: Message[],
    data: ConversationData,
): PlatformReadiness | null => {
    const latestMessage = activeBranchMessages.at(-1);
    const latestUserIndex = activeBranchMessages.findLastIndex((message) => message.author.role === 'user');
    const hasFinishedAssistantHistory = activeBranchMessages.slice(0, latestUserIndex).some(hasFinishedAssistantText);
    if (
        latestMessage?.author.role !== 'user' ||
        latestMessage.status === 'in_progress' ||
        !hasFinishedAssistantHistory
    ) {
        return null;
    }
    const latestUserText = extractMessageText(latestMessage);
    const stableText = latestUserText || latestMessage.id || data.current_node;
    return {
        ready: true,
        terminal: true,
        reason: 'terminal-user-only',
        contentHash: hashText(stableText),
        latestAssistantTextLength: latestUserText.length || 1,
    };
};

const resolveTerminalAssistantReadiness = (
    activeBranchMessages: Message[],
    data: ConversationData,
    options: ChatGPTReadinessOptions,
): PlatformReadiness | null => {
    const latestMessage = activeBranchMessages.at(-1);
    const latestUserIndex = activeBranchMessages.findLastIndex((message) => message.author.role === 'user');
    const latestMessageText = latestMessage ? extractMessageText(latestMessage) : '';
    const isInterrupted =
        options.allowInterruptedAssistant &&
        latestMessage?.author.role === 'assistant' &&
        latestMessage.status !== 'error' &&
        latestMessageText.length === 0;
    if (
        latestMessage?.author.role !== 'assistant' ||
        latestUserIndex < 0 ||
        (!isTerminalNonTextAssistant(latestMessage, latestMessageText) && !isInterrupted)
    ) {
        return null;
    }
    return {
        ready: true,
        terminal: true,
        reason: 'terminal-interrupted',
        contentHash: hashText(latestMessage.id || data.current_node),
        latestAssistantTextLength: 1,
    };
};

/**
 * Evaluates whether a ChatGPT conversation snapshot is ready for canonical export.
 *
 * Readiness requires:
 * - At least one assistant message exists in the current turn on the active branch
 * - A finished assistant text message exists
 * - No later assistant message is still `in_progress`
 *
 * `end_turn` is advisory for history payloads. Modern ChatGPT responses can
 * leave it false or null even after a later text message is finished.
 */
export const evaluateChatGPTReadiness = (
    data: ConversationData,
    options: ChatGPTReadinessOptions = {},
): PlatformReadiness => {
    const activeBranchMessages = collectActiveBranchMessages(data);
    const assistantMessages = collectCurrentTurnAssistantMessages(data);

    if (assistantMessages.length === 0) {
        const terminalUserOnlyReadiness = resolveTerminalUserOnlyReadiness(activeBranchMessages, data);
        if (terminalUserOnlyReadiness) {
            return terminalUserOnlyReadiness;
        }
        return {
            ready: false,
            terminal: false,
            reason: 'assistant-missing',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    const terminalAssistantReadiness = resolveTerminalAssistantReadiness(activeBranchMessages, data, options);
    if (terminalAssistantReadiness) {
        return terminalAssistantReadiness;
    }

    const finishedTextMessages = assistantMessages.filter(hasFinishedAssistantText);
    const latestFinishedText = finishedTextMessages[finishedTextMessages.length - 1];
    const latestFinishedTextIndex = latestFinishedText ? assistantMessages.lastIndexOf(latestFinishedText) : -1;
    const hasLaterInProgressMessage = assistantMessages
        .slice(latestFinishedTextIndex + 1)
        .some((message) => message.status === 'in_progress');

    if (hasLaterInProgressMessage) {
        return {
            ready: false,
            terminal: false,
            reason: 'assistant-in-progress',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    if (!latestFinishedText) {
        return {
            ready: false,
            terminal: true,
            reason: 'assistant-text-missing',
            contentHash: null,
            latestAssistantTextLength: 0,
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
