import type { PlatformReadiness } from '@/platforms/types';
import { hashText } from '@/utils/hash';
import type { ConversationData, MessagePart } from '@/utils/types';

const notReady = (reason: string, terminal = false, latestAssistantTextLength = 0): PlatformReadiness => ({
    ready: false,
    terminal,
    reason,
    contentHash: null,
    latestAssistantTextLength,
});

const extractText = (data: ConversationData): string => {
    const message = data.mapping[data.current_node]?.message;
    if (!message) {
        return '';
    }
    if (typeof message.content.content === 'string' && message.content.content.trim().length > 0) {
        return message.content.content.trim().normalize('NFC');
    }
    return (message.content.parts ?? [])
        .flatMap((part) => {
            if (typeof part === 'string') {
                return [part];
            }
            return part.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
        })
        .join('\n')
        .trim()
        .normalize('NFC');
};

const hasStructuredArtifact = (parts: MessagePart[] | undefined): boolean =>
    (parts ?? []).some(
        (part) =>
            typeof part === 'object' &&
            part !== null &&
            typeof part.type === 'string' &&
            part.type !== 'text' &&
            part.type !== 'thinking',
    );

export const evaluateClaudeReadiness = (data: ConversationData): PlatformReadiness => {
    const currentMessage = data.mapping[data.current_node]?.message;
    if (currentMessage?.author.role !== 'assistant') {
        return notReady('current-assistant-missing');
    }

    const stopReason =
        typeof currentMessage.metadata.claude_stop_reason === 'string'
            ? currentMessage.metadata.claude_stop_reason
            : null;
    const truncated = currentMessage.metadata.claude_truncated === true;
    const text = extractText(data);

    if (truncated) {
        return notReady('assistant-truncated', stopReason === 'end_turn', text.length);
    }
    if (stopReason === null) {
        return notReady('assistant-in-progress');
    }
    if (stopReason !== 'end_turn') {
        return notReady('assistant-non-terminal-stop-reason');
    }
    if (currentMessage.status !== 'finished_successfully' || currentMessage.end_turn !== true) {
        return notReady('assistant-state-not-terminal', true, text.length);
    }

    if (text.length > 0) {
        return {
            ready: true,
            terminal: true,
            reason: 'terminal',
            contentHash: hashText(text),
            latestAssistantTextLength: text.length,
        };
    }

    if (!hasStructuredArtifact(currentMessage.content.parts)) {
        return notReady('assistant-content-missing', true);
    }

    const structuredContent = JSON.stringify(currentMessage.content.parts);
    return {
        ready: true,
        terminal: true,
        reason: 'terminal-structured-content',
        contentHash: hashText(structuredContent || currentMessage.id),
        latestAssistantTextLength: 0,
    };
};
