import type { PlatformReadiness } from '@/platforms/types';
import { hashText } from '@/utils/hash';
import type { ConversationData, MessageNode } from '@/utils/types';

const collectActiveAssistantMessages = (data: ConversationData) => {
    const messages: NonNullable<MessageNode['message']>[] = [];
    const visited = new Set<string>();
    let nodeId: string | null = data.current_node;

    while (nodeId && !visited.has(nodeId)) {
        visited.add(nodeId);
        const node: MessageNode | undefined = data.mapping[nodeId];
        if (!node) {
            return [];
        }
        if (node.message?.author.role === 'assistant') {
            messages.push(node.message);
        }
        nodeId = node.parent;
    }

    return messages.reverse();
};

export const evaluateGrokReadiness = (data: ConversationData): PlatformReadiness => {
    const messages = collectActiveAssistantMessages(data);

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
    if (!latest) {
        return {
            ready: false,
            terminal: false,
            reason: 'assistant-missing',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }
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
