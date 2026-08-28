import type { PlatformReadiness } from '@/platforms/types';
import { hashText } from '@/utils/hash';
import type { ConversationData, Message } from '@/utils/types';
import { getMetaHistoryState } from './parser';

const result = (ready: boolean, terminal: boolean, reason: string, latestText = ''): PlatformReadiness => ({
    ready,
    terminal,
    reason,
    contentHash: latestText.length > 0 ? hashText(latestText) : null,
    latestAssistantTextLength: latestText.length,
});

const getText = (message: Message): string =>
    (message.content.parts ?? [])
        .filter((part): part is string => typeof part === 'string')
        .join('')
        .trim()
        .normalize('NFC');

const getMetaFlags = (message: Message) => {
    const meta = message.metadata.meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
        return { hasError: false, hasStructuredContent: false };
    }
    const record = meta as Record<string, unknown>;
    return {
        hasError: record.hasError === true,
        hasStructuredContent: record.hasStructuredContent === true,
    };
};

export const evaluateMetaReadiness = (data: ConversationData): PlatformReadiness => {
    const messages = Object.values(data.mapping)
        .map((node) => node.message)
        .filter((message): message is Message => message !== null);
    if (messages.length === 0) {
        return result(false, false, 'messages-missing');
    }

    const latest = data.mapping[data.current_node]?.message;
    if (!latest) {
        return result(false, false, 'current-message-missing');
    }
    if (latest.author.role !== 'assistant') {
        return result(false, false, 'latest-message-not-assistant');
    }

    const latestText = getText(latest);
    const assistants = messages.filter((message) => message.author.role === 'assistant');
    if (assistants.length === 0) {
        return result(false, false, 'assistant-missing');
    }
    if (assistants.some((message) => message.status === 'error' || getMetaFlags(message).hasError)) {
        return result(false, false, 'assistant-error', latestText);
    }
    if (assistants.some((message) => message.status === 'in_progress')) {
        return result(false, false, 'assistant-in-progress', latestText);
    }
    if (latest.status !== 'finished_successfully' || latest.end_turn !== true) {
        return result(false, false, 'assistant-not-terminal', latestText);
    }

    const historyState = getMetaHistoryState(data);
    if (historyState === 'unknown') {
        return result(false, true, 'history-state-missing', latestText);
    }
    if (historyState === 'incomplete') {
        return result(false, true, 'history-incomplete', latestText);
    }

    if (latestText.length === 0 && !getMetaFlags(latest).hasStructuredContent) {
        return result(false, true, 'assistant-content-missing');
    }

    return result(true, true, 'terminal', latestText);
};
