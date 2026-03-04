/**
 * Common Export Utility
 *
 * Normalizes conversation JSON into a shared format across LLM providers.
 *
 * @module utils/common-export
 */

import { EXPORT_FORMAT } from '@/utils/settings';
import type { ConversationData, Message, MessageNode } from '@/utils/types';

export type CommonConversationExport = {
    format: typeof EXPORT_FORMAT.COMMON;
    llm: string;
    model?: string;
    title?: string;
    conversation_id?: string;
    created_at?: string;
    updated_at?: string;
    prompt: string;
    response: string;
    reasoning: string[];
};

const toIsoTimestamp = (seconds?: number | null): string | undefined => {
    if (typeof seconds !== 'number' || Number.isNaN(seconds)) {
        return undefined;
    }
    return new Date(seconds * 1000).toISOString();
};

const MODEL_PLACEHOLDERS = new Set(['auto', 'unknown', 'snapshot']);

const extractMessageText = (message: Message): string => {
    const parts = message.content?.parts;
    if (Array.isArray(parts) && parts.length > 0) {
        return parts
            .filter((part) => typeof part === 'string')
            .join('\n')
            .trim();
    }

    if (typeof message.content?.content === 'string') {
        return message.content.content.trim();
    }

    return '';
};

const pushTrimmedIfString = (fragments: string[], value: unknown) => {
    if (typeof value !== 'string') {
        return;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
        fragments.push(trimmed);
    }
};

const extractThoughtReasoning = (message: Message): string[] => {
    const thoughts = message.content?.thoughts;
    if (!Array.isArray(thoughts) || thoughts.length === 0) {
        return [];
    }

    const fragments: string[] = [];
    for (const thought of thoughts) {
        const content = typeof thought?.content === 'string' ? thought.content.trim() : '';
        if (content) {
            fragments.push(content);
            continue;
        }
        pushTrimmedIfString(fragments, thought?.summary);
    }
    return fragments;
};

const extractReasoningRecap = (message: Message): string[] => {
    if (message.content?.content_type !== 'reasoning_recap') {
        return [];
    }
    const fragments: string[] = [];
    pushTrimmedIfString(fragments, message.content?.content);
    return fragments;
};

const extractMetadataReasoning = (message: Message): string[] => {
    const fragments: string[] = [];
    pushTrimmedIfString(fragments, message.metadata?.reasoning);
    pushTrimmedIfString(fragments, message.metadata?.thinking_trace);
    return fragments;
};

const extractReasoningFragments = (message: Message): string[] => {
    return [
        ...extractThoughtReasoning(message),
        ...extractReasoningRecap(message),
        ...extractMetadataReasoning(message),
    ];
};

const dedupeStrings = (values: string[]): string[] => {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const value of values) {
        if (seen.has(value)) {
            continue;
        }
        seen.add(value);
        deduped.push(value);
    }
    return deduped;
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

const getAssistantMessagesByRecency = (conversation: ConversationData): Message[] =>
    Object.values(conversation.mapping)
        .map((node) => node.message)
        .filter((message): message is Message => !!message && message.author?.role === 'assistant')
        .sort((left, right) => getMessageTimestamp(right) - getMessageTimestamp(left));

const getAllMessagesByRecency = (conversation: ConversationData): Message[] =>
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

const normalizeModel = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = value.trim();
    if (!normalized || MODEL_PLACEHOLDERS.has(normalized.toLowerCase())) {
        return undefined;
    }
    return normalized;
};

const extractModelFromMessage = (message: Message): string | undefined =>
    normalizeModel(message.metadata?.resolved_model_slug) ||
    normalizeModel(message.metadata?.model_slug) ||
    normalizeModel(message.metadata?.default_model_slug) ||
    normalizeModel(message.metadata?.model);

const extractModelFromMapping = (conversation: ConversationData): string | undefined => {
    const assistants = getAssistantMessagesByRecency(conversation);
    for (const assistant of assistants) {
        const candidate = extractModelFromMessage(assistant);
        if (candidate) {
            return candidate;
        }
    }
    return undefined;
};

const extractModelFromAnyMessageInMapping = (conversation: ConversationData): string | undefined => {
    const messages = getAllMessagesByRecency(conversation);
    for (const message of messages) {
        const candidate = extractModelFromMessage(message);
        if (candidate) {
            return candidate;
        }
    }
    return undefined;
};

const extractModel = (conversation: ConversationData, chain: Message[]): string | undefined => {
    for (let i = chain.length - 1; i >= 0; i -= 1) {
        const message = chain[i];
        if (message.author?.role !== 'assistant') {
            continue;
        }

        const metadataModel = extractModelFromMessage(message);
        if (metadataModel) {
            return metadataModel;
        }
    }

    const mappingModel = extractModelFromMapping(conversation);
    if (mappingModel) {
        return mappingModel;
    }

    const globalMappingModel = extractModelFromAnyMessageInMapping(conversation);
    if (globalMappingModel) {
        return globalMappingModel;
    }

    return normalizeModel(conversation.default_model_slug);
};

const findTerminalAssistantIndex = (chain: Message[]): number => {
    for (let i = chain.length - 1; i >= 0; i -= 1) {
        const message = chain[i];
        if (message.author?.role !== 'assistant') {
            continue;
        }
        if (extractMessageText(message) || extractReasoningFragments(message).length > 0) {
            return i;
        }
    }
    return -1;
};

const findLastUserBefore = (chain: Message[], endIndex: number): number => {
    for (let i = endIndex - 1; i >= 0; i -= 1) {
        if (chain[i].author?.role === 'user') {
            return i;
        }
    }
    return -1;
};

const findLatestResponseText = (chain: Message[], startIndex: number, endIndex: number): string => {
    for (let i = endIndex; i > startIndex; i -= 1) {
        const message = chain[i];
        if (message.author?.role !== 'assistant') {
            continue;
        }
        const text = extractMessageText(message);
        if (text) {
            return text;
        }
    }
    return '';
};

const collectReasoningForRange = (chain: Message[], startIndex: number, endIndex: number): string[] => {
    const collected: string[] = [];
    for (let i = startIndex + 1; i <= endIndex; i += 1) {
        const message = chain[i];
        if (message.author?.role !== 'assistant') {
            continue;
        }
        collected.push(...extractReasoningFragments(message));
    }
    return dedupeStrings(collected.filter((value) => value.length > 0));
};

const collectLatestAssistantReasoningFromMapping = (
    conversation: ConversationData,
    minTimestampInclusive: number | null,
): string[] => {
    const assistants = getAssistantMessagesByRecency(conversation);
    for (const assistant of assistants) {
        if (typeof minTimestampInclusive === 'number' && getMessageTimestamp(assistant) < minTimestampInclusive) {
            continue;
        }
        const fragments = extractReasoningFragments(assistant);
        if (fragments.length > 0) {
            return dedupeStrings(fragments);
        }
    }
    return [];
};

const extractLatestPrompt = (chain: Message[]): string => {
    for (let i = chain.length - 1; i >= 0; i -= 1) {
        const message = chain[i];
        if (message.author?.role === 'user') {
            return extractMessageText(message);
        }
    }
    return '';
};

/**
 * Build a normalized conversation export from Blackiya's ConversationData.
 */
export const buildCommonExport = (conversation: ConversationData, llmName: string): CommonConversationExport => {
    const currentNodeId = findCurrentNodeId(conversation);
    const chain = currentNodeId ? buildMessageChain(conversation.mapping, currentNodeId) : [];

    const assistantIndex = findTerminalAssistantIndex(chain);
    const userIndex = assistantIndex >= 0 ? findLastUserBefore(chain, assistantIndex) : -1;

    const prompt = userIndex >= 0 ? extractMessageText(chain[userIndex]) : extractLatestPrompt(chain);
    const response = assistantIndex >= 0 ? findLatestResponseText(chain, userIndex, assistantIndex) : '';
    const reasoningFromChain = assistantIndex >= 0 ? collectReasoningForRange(chain, userIndex, assistantIndex) : [];
    const minReasoningTimestamp: number | null =
        userIndex >= 0 && chain[userIndex] ? getMessageTimestamp(chain[userIndex]) : null;
    const reasoning =
        reasoningFromChain.length > 0
            ? reasoningFromChain
            : collectLatestAssistantReasoningFromMapping(conversation, minReasoningTimestamp);

    return {
        format: EXPORT_FORMAT.COMMON,
        llm: llmName,
        model: extractModel(conversation, chain),
        title: conversation.title || undefined,
        conversation_id: conversation.conversation_id || undefined,
        created_at: toIsoTimestamp(conversation.create_time),
        updated_at: toIsoTimestamp(conversation.update_time),
        prompt,
        response,
        reasoning,
    };
};
