import { LRUCache } from '@/utils/lru-cache';
import type { ConversationData } from '@/utils/types';

/**
 * Encapsulates all mutable adapter state to prevent cross-test/session leakage.
 * Use `resetGrokAdapterState()` in tests to get a clean state.
 */
export class GrokAdapterState {
    /** Maps conversation ID (rest_id) to title */
    readonly conversationTitles = new LRUCache<string, string>(50);
    /** Track active conversation objects for retroactive title updates */
    readonly activeConversations = new LRUCache<string, ConversationData>(50);
    /** Most recently active grok.com conversation ID (last-resort fallback) */
    lastActiveConversationId: string | null = null;

    reset(): void {
        this.conversationTitles.clear();
        this.activeConversations.clear();
        this.lastActiveConversationId = null;
    }
}

export const grokState = new GrokAdapterState();

export const resetGrokAdapterState = (): void => {
    grokState.reset();
};
