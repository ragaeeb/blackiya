import type { PlatformReadiness } from '@/platforms/types';
import { hashText } from '@/utils/hash';
import type { ConversationData } from '@/utils/types';

const notReady = (reason: string, terminal = false, latestAssistantTextLength = 0): PlatformReadiness => ({
    ready: false,
    terminal,
    reason,
    contentHash: null,
    latestAssistantTextLength,
});

export const evaluateDeepSeekReadiness = (data: ConversationData): PlatformReadiness => {
    const current = data.mapping[data.current_node]?.message;
    if (current?.author.role !== 'assistant') {
        return notReady('current-assistant-missing');
    }
    if (current.status !== 'finished_successfully' || current.end_turn !== true) {
        return notReady('assistant-in-progress');
    }

    const text = (current.content.parts ?? [])
        .filter((part): part is string => typeof part === 'string')
        .join('')
        .trim()
        .normalize('NFC');
    if (!text) {
        return notReady('assistant-text-missing', true);
    }

    return {
        ready: true,
        terminal: true,
        reason: 'terminal',
        contentHash: hashText(text),
        latestAssistantTextLength: text.length,
    };
};
