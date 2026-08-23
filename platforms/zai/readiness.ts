import type { PlatformReadiness } from '@/platforms/types';
import { hashText } from '@/utils/hash';
import type { ConversationData, Message, MessageNode } from '@/utils/types';

const notReady = (reason: string, terminal = false, latestAssistantTextLength = 0): PlatformReadiness => ({
    ready: false,
    terminal,
    reason,
    contentHash: null,
    latestAssistantTextLength,
});

const collectActiveBranchMessages = (data: ConversationData): Message[] => {
    const messages: Message[] = [];
    const visited = new Set<string>();
    let nodeId: string | null = data.current_node;

    while (nodeId && !visited.has(nodeId)) {
        visited.add(nodeId);
        const node: MessageNode | undefined = data.mapping[nodeId];
        if (!node) {
            return [];
        }
        if (node.message) {
            messages.push(node.message);
        }
        nodeId = node.parent;
    }
    return messages.reverse();
};

const currentTurnAssistantMessages = (messages: Message[]) => {
    const latestUserIndex = messages.findLastIndex((message) => message.author.role === 'user');
    return messages.slice(latestUserIndex + 1).filter((message) => message.author.role === 'assistant');
};

const extractText = (message: Message) =>
    (message.content.parts ?? [])
        .filter((part): part is string => typeof part === 'string')
        .join('\n')
        .trim()
        .normalize('NFC');

export const evaluateZaiReadiness = (data: ConversationData): PlatformReadiness => {
    const assistantMessages = currentTurnAssistantMessages(collectActiveBranchMessages(data));
    if (assistantMessages.length === 0) {
        return notReady('assistant-missing');
    }
    if (assistantMessages.some((message) => message.status === 'error')) {
        return notReady(
            'assistant-error',
            assistantMessages.some((message) => message.end_turn === true),
        );
    }
    if (assistantMessages.some((message) => message.status === 'in_progress')) {
        return notReady('assistant-in-progress');
    }

    const latest = assistantMessages.at(-1);
    if (latest?.metadata.zai_done !== true || latest.end_turn !== true) {
        return notReady('assistant-terminal-marker-missing');
    }

    const text = extractText(latest);
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
