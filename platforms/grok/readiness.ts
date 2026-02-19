import type { PlatformReadiness } from '@/platforms/types';
import { hashText } from '@/utils/hash';
import type { ConversationData, MessageNode } from '@/utils/types';

export const evaluateGrokReadiness = (data: ConversationData): PlatformReadiness => {
    const messages = Object.values(data.mapping)
        .map((node) => node.message)
        .filter(
            (message): message is NonNullable<MessageNode['message']> =>
                !!message && message.author.role === 'assistant',
        )
        .sort((left, right) => {
            const leftTs = left.update_time ?? left.create_time ?? 0;
            const rightTs = right.update_time ?? right.create_time ?? 0;
            return leftTs - rightTs;
        });

    if (messages.length === 0) {
        return {
            ready: false,
            terminal: false,
            reason: 'assistant-missing',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    if (messages.some((message) => message.status === 'in_progress')) {
        return {
            ready: false,
            terminal: false,
            reason: 'assistant-in-progress',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    const latest = messages[messages.length - 1];
    const latestText = (latest.content.parts ?? []).filter((part): part is string => typeof part === 'string').join('');
    const normalized = latestText.trim().normalize('NFC');

    if (normalized.length === 0) {
        return {
            ready: false,
            terminal: true,
            reason: 'assistant-text-missing',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    if (latest.status !== 'finished_successfully' || latest.end_turn !== true) {
        return {
            ready: false,
            terminal: true,
            reason: 'assistant-latest-text-not-terminal-turn',
            contentHash: null,
            latestAssistantTextLength: normalized.length,
        };
    }

    return {
        ready: true,
        terminal: true,
        reason: 'terminal',
        contentHash: hashText(normalized),
        latestAssistantTextLength: normalized.length,
    };
};
