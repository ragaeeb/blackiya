import type { ConversationData, Message } from '@/utils/types';

function trimmedString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function hasNonEmptyParts(message: Message): boolean {
    const parts = message.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
        return false;
    }
    return parts.some((part) => trimmedString(part).length > 0);
}

function hasNonEmptyContentField(message: Message): boolean {
    return trimmedString(message.content?.content).length > 0;
}

function hasNonEmptyThoughts(message: Message): boolean {
    const thoughts = message.content?.thoughts;
    if (!Array.isArray(thoughts) || thoughts.length === 0) {
        return false;
    }

    return thoughts.some((thought) => {
        if (!thought || typeof thought !== 'object') {
            return false;
        }
        const summary = trimmedString(thought.summary);
        const content = trimmedString(thought.content);
        const chunks = Array.isArray(thought.chunks)
            ? thought.chunks.some((chunk) => trimmedString(chunk).length > 0)
            : false;
        return summary.length > 0 || content.length > 0 || chunks;
    });
}

function hasReasoningMetadata(message: Message): boolean {
    return (
        trimmedString(message.metadata?.reasoning).length > 0 ||
        trimmedString(message.metadata?.thinking_trace).length > 0
    );
}

export function hasMeaningfulAssistantContent(message: Message): boolean {
    if (message.author?.role !== 'assistant') {
        return false;
    }

    return (
        hasNonEmptyParts(message) ||
        hasNonEmptyContentField(message) ||
        hasNonEmptyThoughts(message) ||
        hasReasoningMetadata(message)
    );
}

export function isConversationReady(conversation: ConversationData): boolean {
    if (!conversation || typeof conversation !== 'object') {
        return false;
    }

    const mapping = (conversation as Partial<ConversationData>).mapping;
    if (!mapping || typeof mapping !== 'object') {
        return false;
    }

    const assistantMessages = Object.values(mapping)
        .map((node) => node?.message)
        .filter((message): message is NonNullable<typeof message> => !!message && message.author?.role === 'assistant');

    if (assistantMessages.length === 0) {
        return false;
    }

    const hasInProgress = assistantMessages.some((message) => message.status === 'in_progress');
    if (hasInProgress) {
        return false;
    }

    const finished = assistantMessages.filter((message) => message.status === 'finished_successfully');
    if (finished.length === 0) {
        return false;
    }

    return finished.some((message) => hasMeaningfulAssistantContent(message));
}
