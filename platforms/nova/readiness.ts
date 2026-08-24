import type { PlatformReadiness } from '@/platforms/types';
import { hashText } from '@/utils/hash';
import type { ConversationData, MessageNode } from '@/utils/types';

const notReady = (reason: string, terminal: boolean, latestAssistantTextLength = 0): PlatformReadiness => ({
    ready: false,
    terminal,
    reason,
    contentHash: null,
    latestAssistantTextLength,
});

const hasMaterialStructuredValue = (value: unknown): boolean => {
    if (typeof value === 'string') {
        return value.trim().length > 0;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value);
    }
    if (Array.isArray(value)) {
        return value.some(hasMaterialStructuredValue);
    }
    if (value !== null && typeof value === 'object') {
        return Object.values(value).some(hasMaterialStructuredValue);
    }
    return false;
};

export const evaluateNovaReadiness = (data: ConversationData): PlatformReadiness => {
    const assistantMessages = Object.values(data.mapping)
        .map((node) => node.message)
        .filter(
            (message): message is NonNullable<MessageNode['message']> =>
                !!message && message.author.role === 'assistant',
        );

    if (assistantMessages.length === 0) {
        return notReady('assistant-missing', false);
    }
    if (assistantMessages.some((message) => message.status === 'in_progress')) {
        return notReady('assistant-in-progress', false);
    }

    const latest = assistantMessages[assistantMessages.length - 1];
    if (!latest) {
        return notReady('assistant-missing', false);
    }
    if (latest.status === 'error') {
        return notReady('assistant-error', true);
    }
    if (latest.status !== 'finished_successfully' || latest.end_turn !== true) {
        return notReady('assistant-latest-not-terminal-turn', false);
    }

    const parts = latest.content.parts ?? [];
    const normalizedText = parts
        .filter((part): part is string => typeof part === 'string')
        .join('')
        .trim()
        .normalize('NFC');
    if (normalizedText.length > 0) {
        return {
            ready: true,
            terminal: true,
            reason: 'terminal',
            contentHash: hashText(normalizedText),
            latestAssistantTextLength: normalizedText.length,
        };
    }

    const structuredParts = parts.filter(
        (part) => typeof part === 'object' && part !== null && hasMaterialStructuredValue(part),
    );
    if (structuredParts.length > 0) {
        return {
            ready: true,
            terminal: true,
            reason: 'terminal-structured-content',
            contentHash: hashText(JSON.stringify(structuredParts)),
            latestAssistantTextLength: 0,
        };
    }

    return notReady('assistant-content-missing', true);
};
