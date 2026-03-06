import type { ConversationData, Message, MessageNode } from '@/utils/types';

const MODEL_PLACEHOLDERS = new Set(['auto', 'unknown', 'snapshot']);

const trimString = (value: unknown): string | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

export const extractMessageText = (message: Message): string => {
    const parts = message.content?.parts;
    if (Array.isArray(parts) && parts.length > 0) {
        return parts
            .filter((part): part is string => typeof part === 'string')
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
            .join('\n');
    }

    return trimString(message.content?.content) ?? '';
};

const getMessageTimestamp = (message: Message): number => {
    if (typeof message.update_time === 'number' && Number.isFinite(message.update_time)) {
        return message.update_time;
    }
    if (typeof message.create_time === 'number' && Number.isFinite(message.create_time)) {
        return message.create_time;
    }
    return 0;
};

const getMessagesByRecency = (conversation: ConversationData): Message[] =>
    Object.values(conversation.mapping)
        .map((node) => node.message)
        .filter((message): message is Message => !!message)
        .sort((left, right) => getMessageTimestamp(right) - getMessageTimestamp(left));

const findCurrentNodeId = (conversation: ConversationData): string | null => {
    const mapping = conversation.mapping;
    if (conversation.current_node && mapping[conversation.current_node]?.message) {
        return conversation.current_node;
    }

    const nodes = Object.values(mapping);
    const assistantNodes = nodes
        .filter((node) => node.message?.author?.role === 'assistant')
        .sort((left, right) => {
            const leftTime = left.message?.create_time ?? left.message?.update_time ?? 0;
            const rightTime = right.message?.create_time ?? right.message?.update_time ?? 0;
            return rightTime - leftTime;
        });

    if (assistantNodes.length > 0) {
        return assistantNodes[0]?.id ?? null;
    }

    const leafNodes = nodes
        .filter((node) => node.message && (!node.children || node.children.length === 0))
        .sort((left, right) => {
            const leftTime = left.message?.create_time ?? left.message?.update_time ?? 0;
            const rightTime = right.message?.create_time ?? right.message?.update_time ?? 0;
            return rightTime - leftTime;
        });

    return leafNodes[0]?.id ?? null;
};

const buildMessageChain = (mapping: Record<string, MessageNode>, startId: string): Message[] => {
    const chain: Message[] = [];
    let currentId: string | null = startId;
    const visited = new Set<string>();

    while (currentId && mapping[currentId] && !visited.has(currentId)) {
        visited.add(currentId);
        const node: MessageNode = mapping[currentId];
        if (node.message) {
            chain.unshift(node.message);
        }
        currentId = node.parent ?? null;
    }

    return chain;
};

const normalizeModel = (value: unknown): string | undefined => {
    const trimmed = trimString(value);
    if (!trimmed || MODEL_PLACEHOLDERS.has(trimmed.toLowerCase())) {
        return undefined;
    }
    return trimmed;
};

const extractModelFromMessage = (message: Message): string | undefined =>
    normalizeModel(message.metadata?.resolved_model_slug) ||
    normalizeModel(message.metadata?.model_slug) ||
    normalizeModel(message.metadata?.default_model_slug) ||
    normalizeModel(message.metadata?.model);

const extractThoughtReasoning = (message: Message): string[] => {
    const thoughts = message.content?.thoughts;
    if (!Array.isArray(thoughts) || thoughts.length === 0) {
        return [];
    }

    const fragments: string[] = [];
    for (const thought of thoughts) {
        const content = trimString(thought?.content);
        if (content) {
            fragments.push(content);
            continue;
        }
        const summary = trimString(thought?.summary);
        if (summary) {
            fragments.push(summary);
        }
    }
    return fragments;
};

const extractReasoningRecap = (message: Message): string[] => {
    if (message.content?.content_type !== 'reasoning_recap') {
        return [];
    }
    const content = trimString(message.content?.content);
    return content ? [content] : [];
};

const extractMetadataReasoning = (message: Message): string[] => {
    const fragments = [trimString(message.metadata?.reasoning), trimString(message.metadata?.thinking_trace)];
    return fragments.filter((fragment): fragment is string => !!fragment);
};

export const extractReasoningFragments = (message: Message): string[] => [
    ...extractThoughtReasoning(message),
    ...extractReasoningRecap(message),
    ...extractMetadataReasoning(message),
];

export const extractConversationReasoning = (conversation: ConversationData): string[] => {
    const seen = new Set<string>();
    const reasoning: string[] = [];

    for (const message of getMessagesByRecency(conversation)) {
        if (message.author.role !== 'assistant') {
            continue;
        }
        for (const fragment of extractReasoningFragments(message)) {
            if (seen.has(fragment)) {
                continue;
            }
            seen.add(fragment);
            reasoning.push(fragment);
        }
    }

    return reasoning;
};

export const extractConversationModel = (conversation: ConversationData): string | undefined => {
    for (const message of getMessagesByRecency(conversation)) {
        const model = extractModelFromMessage(message);
        if (model) {
            return model;
        }
    }

    return normalizeModel(conversation.default_model_slug);
};

export const extractLatestTurnPromptAndResponse = (
    conversation: ConversationData,
): {
    prompt: string;
    response: string;
} => {
    const currentNodeId = findCurrentNodeId(conversation);
    const chain = currentNodeId ? buildMessageChain(conversation.mapping, currentNodeId) : [];

    let prompt = '';
    let response = '';

    for (const message of chain) {
        const text = extractMessageText(message);
        if (!text) {
            continue;
        }
        if (message.author.role === 'user') {
            prompt = text;
        } else if (message.author.role === 'assistant') {
            response = text;
        }
    }

    if (prompt || response) {
        return { prompt, response };
    }

    for (const message of getMessagesByRecency(conversation)) {
        const text = extractMessageText(message);
        if (!text) {
            continue;
        }
        if (!response && message.author.role === 'assistant') {
            response = text;
        }
        if (!prompt && message.author.role === 'user') {
            prompt = text;
        }
        if (prompt && response) {
            break;
        }
    }

    return { prompt, response };
};

export const extractAllAssistantText = (conversation: ConversationData): string =>
    Object.values(conversation.mapping)
        .map((node) => node.message)
        .filter((message): message is Message => !!message)
        .filter((message) => message.author.role === 'assistant')
        .map((message) => extractMessageText(message))
        .filter((text) => text.length > 0)
        .join('\n\n')
        .trim();
