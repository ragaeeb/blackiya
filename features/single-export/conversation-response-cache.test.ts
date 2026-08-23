import { describe, expect, it } from 'bun:test';
import type { ConversationData } from '@/utils/types';
import { ConversationResponseCache } from './conversation-response-cache';

const makeConversation = (id: string, title = 'Cached conversation'): ConversationData => ({
    title,
    create_time: 1,
    update_time: 2,
    mapping: {},
    conversation_id: id,
    current_node: 'root',
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'test',
    safe_urls: [],
    blocked_urls: [],
});

describe('ConversationResponseCache', () => {
    it('should return a defensive snapshot for a fresh provider conversation', () => {
        const cache = new ConversationResponseCache();
        cache.set('Grok', makeConversation('12345678901234567890'));

        const first = cache.get('Grok', '12345678901234567890');
        expect(first?.title).toBe('Cached conversation');
        if (first) {
            first.title = 'mutated';
        }
        expect(cache.get('Grok', '12345678901234567890')?.title).toBe('Cached conversation');
    });

    it('should expire entries and enforce the entry bound', () => {
        let now = 100;
        const cache = new ConversationResponseCache({ maxEntries: 1, maxAgeMs: 10, now: () => now });
        cache.set('One', makeConversation('one'));
        cache.set('Two', makeConversation('two'));
        expect(cache.get('One', 'one')).toBeUndefined();
        expect(cache.get('Two', 'two')).toBeDefined();

        now = 111;
        expect(cache.get('Two', 'two')).toBeUndefined();
    });

    it('should actively prune every expired entry during unrelated reads and writes', () => {
        let now = 100;
        const cache = new ConversationResponseCache({ maxAgeMs: 10, now: () => now });
        cache.set('One', makeConversation('one'));
        cache.set('Two', makeConversation('two'));

        now = 111;
        expect(cache.get('Missing', 'missing')).toBeUndefined();
        cache.set('Three', makeConversation('three'));

        now = 105;
        expect(cache.get('One', 'one')).toBeUndefined();
        expect(cache.get('Two', 'two')).toBeUndefined();
        expect(cache.get('Three', 'three')).toBeDefined();
    });

    it('should clear only conversations belonging to one provider', () => {
        const cache = new ConversationResponseCache();
        cache.set('ChatGPT', makeConversation('chatgpt'));
        cache.set('Gemini', makeConversation('gemini'));

        cache.clear('ChatGPT');

        expect(cache.get('ChatGPT', 'chatgpt')).toBeUndefined();
        expect(cache.get('Gemini', 'gemini')).toBeDefined();
    });

    it('should reject an entry larger than the byte bound', () => {
        const cache = new ConversationResponseCache({ maxBytesPerEntry: 64 });
        expect(cache.set('Grok', makeConversation('large', 'x'.repeat(1000)))).toBeFalse();
        expect(cache.get('Grok', 'large')).toBeUndefined();
    });
});
