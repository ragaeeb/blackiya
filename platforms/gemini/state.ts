import { LRUCache } from '@/utils/lru-cache';
import type { ConversationData } from '@/utils/types';

/**
 * Encapsulates mutable Gemini adapter state so tests can reliably reset
 * singleton caches between cases.
 */
export class GeminiAdapterState {
    readonly conversationTitles = new LRUCache<string, string>(50);
    readonly activeConversations = new LRUCache<string, ConversationData>(50);

    reset() {
        this.conversationTitles.clear();
        this.activeConversations.clear();
    }
}

export const geminiState = new GeminiAdapterState();

export const resetGeminiAdapterState = () => {
    geminiState.reset();
};
