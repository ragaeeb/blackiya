/**
 * Common Export Utility
 *
 * Normalizes conversation JSON into a shared format across LLM providers.
 *
 * @module utils/common-export
 */

import type { ConversationData, Message, MessageNode } from '@/utils/types';

export interface CommonConversationTurn {
    prompt: string;
    response: string;
    reasoning?: string;
    timestamp?: string;
}

export interface CommonConversationExport {
    format: 'common';
    llm: string;
    model?: string;
    title?: string;
    conversation_id?: string;
    created_at?: string;
    updated_at?: string;
    turns: CommonConversationTurn[];
}

const toIsoTimestamp = (seconds?: number | null): string | undefined => {
    if (typeof seconds !== 'number' || Number.isNaN(seconds)) {
        return undefined;
    }
    return new Date(seconds * 1000).toISOString();
};

const extractMessageText = (message: Message): string => {
    const parts = message.content?.parts;
    if (Array.isArray(parts) && parts.length > 0) {
        return parts.filter((part) => typeof part === 'string').join('\n');
    }

    if (typeof message.content?.content === 'string') {
        return message.content.content;
    }

    return '';
};

const extractReasoning = (message: Message): string | undefined => {
    const thoughts = message.content?.thoughts;
    if (Array.isArray(thoughts) && thoughts.length > 0) {
        const reasoningParts = thoughts
            .map((thought) => thought?.content)
            .filter((content) => typeof content === 'string' && content.trim().length > 0);
        if (reasoningParts.length > 0) {
            return reasoningParts.join('\n\n');
        }
    }

    if (message.content?.content_type === 'reasoning_recap' && typeof message.content?.content === 'string') {
        const recap = message.content.content.trim();
        return recap.length > 0 ? recap : undefined;
    }

    const metadataReasoning = message.metadata?.reasoning;
    if (typeof metadataReasoning === 'string' && metadataReasoning.trim().length > 0) {
        return metadataReasoning;
    }

    const thinkingTrace = message.metadata?.thinking_trace;
    if (typeof thinkingTrace === 'string' && thinkingTrace.trim().length > 0) {
        return thinkingTrace;
    }

    return undefined;
};

const findCurrentNodeId = (conversation: ConversationData): string | null => {
    const mapping = conversation.mapping;
    if (conversation.current_node && mapping[conversation.current_node]?.message) {
        return conversation.current_node;
    }

    const nodes = Object.values(mapping);
    const assistantNodes = nodes
        .filter((node) => node.message?.author?.role === 'assistant')
        .sort((a, b) => {
            const timeA = a.message?.create_time ?? a.message?.update_time ?? 0;
            const timeB = b.message?.create_time ?? b.message?.update_time ?? 0;
            return timeB - timeA;
        });

    if (assistantNodes.length > 0) {
        return assistantNodes[0]?.id ?? null;
    }

    const leafNodes = nodes
        .filter((node) => node.message && (!node.children || node.children.length === 0))
        .sort((a, b) => {
            const timeA = a.message?.create_time ?? a.message?.update_time ?? 0;
            const timeB = b.message?.create_time ?? b.message?.update_time ?? 0;
            return timeB - timeA;
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

const extractModel = (conversation: ConversationData, chain: Message[]): string | undefined => {
    if (conversation.default_model_slug && conversation.default_model_slug.trim().length > 0) {
        return conversation.default_model_slug;
    }

    for (let i = chain.length - 1; i >= 0; i -= 1) {
        const message = chain[i];
        if (message.author?.role !== 'assistant') {
            continue;
        }

        const model = message.metadata?.model;
        if (typeof model === 'string' && model.trim().length > 0) {
            return model;
        }
    }

    return undefined;
};

/**
 * Build a normalized conversation export from Blackiya's ConversationData.
 */
export const buildCommonExport = (conversation: ConversationData, llmName: string): CommonConversationExport => {
    const currentNodeId = findCurrentNodeId(conversation);
    const chain = currentNodeId ? buildMessageChain(conversation.mapping, currentNodeId) : [];

    const turns: CommonConversationTurn[] = [];
    let lastPrompt = '';

    for (const message of chain) {
        if (message.author.role === 'user') {
            const promptText = extractMessageText(message);
            if (promptText) {
                lastPrompt = promptText;
            }
            continue;
        }

        if (message.author.role !== 'assistant') {
            continue;
        }

        const responseText = extractMessageText(message);
        const reasoning = extractReasoning(message);
        const timestamp = toIsoTimestamp(message.create_time) ?? toIsoTimestamp(conversation.update_time);

        if (!responseText && !lastPrompt) {
            continue;
        }

        turns.push({
            prompt: lastPrompt,
            response: responseText,
            reasoning,
            timestamp,
        });
    }

    return {
        format: 'common',
        llm: llmName,
        model: extractModel(conversation, chain),
        title: conversation.title || undefined,
        conversation_id: conversation.conversation_id || undefined,
        created_at: toIsoTimestamp(conversation.create_time),
        updated_at: toIsoTimestamp(conversation.update_time),
        turns,
    };
};
