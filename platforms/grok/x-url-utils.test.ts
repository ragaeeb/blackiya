import { describe, expect, it } from 'bun:test';
import {
    buildXGrokConversationItemsUrl,
    extractXGrokConversationId,
    isXGrokConversationItemsEndpoint,
} from './x-url-utils';

const CONVERSATION_ID = '2091428436845772921';

describe('x.com Grok URL utilities', () => {
    it('should extract a conversation id from the x.com Grok page URL', () => {
        expect(extractXGrokConversationId(`https://x.com/i/grok?conversation=${CONVERSATION_ID}`)).toBe(
            CONVERSATION_ID,
        );
    });

    it('should extract a conversation id from the GraphQL detail request', () => {
        const url = buildXGrokConversationItemsUrl(CONVERSATION_ID);
        expect(extractXGrokConversationId(url)).toBe(CONVERSATION_ID);
        expect(isXGrokConversationItemsEndpoint(url)).toBeTrue();
    });

    it('should reject non-Grok x.com pages and malformed ids', () => {
        expect(extractXGrokConversationId('https://x.com/home')).toBeNull();
        expect(extractXGrokConversationId('https://x.com/i/grok?conversation=not-numeric')).toBeNull();
        expect(isXGrokConversationItemsEndpoint('https://x.com/i/api/graphql/hash/HomeTimeline')).toBeFalse();
    });
});
