import type { ConversationData, Message, MessageNode } from '@/utils/types';

const activeBranchMessages = (data: ConversationData): Message[] => {
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

const transcriptText = (message: Message): string => {
    if (message.content.content_type !== 'text') {
        return '';
    }
    const parts = Array.isArray(message.content.parts)
        ? message.content.parts.filter((part): part is string => typeof part === 'string')
        : [];
    const text = parts.length > 0 ? parts.join('\n\n') : message.content.content;
    return typeof text === 'string' ? text.trim().normalize('NFC') : '';
};

const markdownTitle = (title: string): string => title.replace(/\s+/g, ' ').trim() || 'Conversation';

export const conversationToMarkdown = (data: ConversationData): string => {
    const sections = activeBranchMessages(data)
        .filter((message) => message.author.role === 'user' || message.author.role === 'assistant')
        .map((message) => ({
            label: message.author.role === 'user' ? 'User' : 'Assistant',
            text: transcriptText(message),
        }))
        .filter((section) => section.text.length > 0)
        .map((section) => `## ${section.label}\n\n${section.text}`);

    return `${[`# ${markdownTitle(data.title)}`, ...sections].join('\n\n')}\n`;
};
