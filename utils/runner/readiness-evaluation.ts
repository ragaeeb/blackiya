/**
 * Fallback readiness evaluation for conversation data.
 *
 * When an adapter provides its own `evaluateReadiness`, that takes precedence.
 * Otherwise this module provides a generic evaluator based on assistant message
 * status and content hashing.
 */

import type { LLMPlatform, PlatformReadiness } from '@/platforms/types';
import { isConversationReady } from '@/utils/conversation-readiness';
import { hashText } from '@/utils/hash';
import type { ConversationData } from '@/utils/types';

const normalizeContentText = (text: string): string => text.trim().normalize('NFC');

const INVALID_SHAPE_READINESS: PlatformReadiness = {
    ready: false,
    terminal: false,
    reason: 'invalid-conversation-shape',
    contentHash: null,
    latestAssistantTextLength: 0,
};

/**
 * Evaluates readiness for a conversation data object. Delegates to the
 * adapter's `evaluateReadiness` when available, otherwise uses generic
 * assistant message analysis.
 */
export const evaluateReadinessForData = (
    data: ConversationData,
    adapter: LLMPlatform | null,
): PlatformReadiness => {
    if (!data || !data.mapping || typeof data.mapping !== 'object') {
        return INVALID_SHAPE_READINESS;
    }
    if (adapter?.evaluateReadiness) {
        return adapter.evaluateReadiness(data);
    }
    const assistantMessages = Object.values(data.mapping)
        .map((node) => node?.message)
        .filter((msg): msg is NonNullable<(typeof data.mapping)[string]['message']> => !!msg)
        .filter((msg) => msg.author.role === 'assistant');
    const latestAssistant = assistantMessages[assistantMessages.length - 1];
    const text = normalizeContentText((latestAssistant?.content.parts ?? []).join(''));
    const hasInProgress = assistantMessages.some((msg) => msg.status === 'in_progress');
    const terminal = !hasInProgress;
    return {
        ready: isConversationReady(data),
        terminal,
        reason: terminal ? 'terminal-snapshot' : 'assistant-in-progress',
        contentHash: text.length > 0 ? hashText(text) : null,
        latestAssistantTextLength: text.length,
    };
};
