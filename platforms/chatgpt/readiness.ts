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

const isExplicitlyEndedReasoningRecap = (message: Message): boolean =>
    message.status === 'finished_successfully' &&
    message.content.content_type === 'reasoning_recap' &&
    message.metadata?.reasoning_status === 'reasoning_ended';

const isCompletedDeepResearchAssistant = (message: Message | undefined): boolean =>
    message?.author.role === 'assistant' &&
    message.status === 'finished_successfully' &&
    message.content.content_type === 'code' &&
    message.metadata?.is_complete === true &&
    message.metadata?.message_type === 'next';

const isTerminalDeepResearchToolBranch = (activeBranchMessages: Message[]): boolean => {
    const latestMessage = activeBranchMessages.at(-1);
    const precedingMessage = activeBranchMessages.at(-2);
    return (
        latestMessage?.author.role === 'tool' &&
        latestMessage.status === 'finished_successfully' &&
        latestMessage.content.content_type === 'code' &&
        latestMessage.metadata?.message_type === 'next' &&
        isCompletedDeepResearchAssistant(precedingMessage)
    );
};

const isTerminalNonTextAssistant = (message: Message, text: string): boolean => {
    if (isExplicitlyEndedReasoningRecap(message)) {
        return true;
    }
    return (
        message.status === 'finished_successfully' &&
        message.end_turn === true &&
        text.length === 0 &&
        message.content.content_type !== 'text' &&
        message.content.content_type !== 'thoughts'
    );
};

const resolveTerminalAssistantReadiness = (
    activeBranchMessages: Message[],
    data: ConversationData,
): PlatformReadiness | null => {
    const latestMessage = activeBranchMessages.at(-1);
    const latestUserIndex = activeBranchMessages.findLastIndex((message) => message.author.role === 'user');
    const latestMessageText = latestMessage ? extractMessageText(latestMessage) : '';
    const hasTerminalMarker =
        (latestMessage?.author.role === 'assistant' &&
            isTerminalNonTextAssistant(latestMessage, latestMessageText)) ||
        isTerminalDeepResearchToolBranch(activeBranchMessages);
    if (
        latestUserIndex < 0 ||
        !hasTerminalMarker
    ) {
        return null;
    }
    return {
        ready: true,
        terminal: true,
        reason: 'terminal-marker',
        contentHash: hashText(latestMessage?.id || data.current_node),
        latestAssistantTextLength: 1,
    };
};

/**
 * Evaluates whether a ChatGPT conversation snapshot is ready for canonical export.
 *
 * Readiness requires:
 * - The active branch ends in a finished assistant text message or an
 *   explicit terminal non-text marker, including a reasoning recap whose
 *   metadata says reasoning has ended or a completed deep-research tool turn
 * - No later assistant message is still `in_progress`
 *
 * `end_turn` is advisory for history payloads. Modern ChatGPT responses can
 * leave it false or null even after a later text message is finished.
 */
export const evaluateChatGPTReadiness = (
    data: ConversationData,
): PlatformReadiness => {
    const activeBranchMessages = collectActiveBranchMessages(data);
    const assistantMessages = collectCurrentTurnAssistantMessages(data);

    if (assistantMessages.length === 0) {
        return {
            ready: false,
            terminal: false,
            reason: 'assistant-missing',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    const terminalAssistantReadiness = resolveTerminalAssistantReadiness(activeBranchMessages, data);
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
            terminal: false,
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
