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

    it('should require the exact canonical provider origin and GraphQL path', () => {
        const canonical = new URL(buildXGrokConversationItemsUrl(CONVERSATION_ID));
        expect(isXGrokConversationItemsEndpoint(`http://x.com${canonical.pathname}${canonical.search}`)).toBeFalse();
        expect(
            isXGrokConversationItemsEndpoint(`https://www.x.com${canonical.pathname}${canonical.search}`),
        ).toBeFalse();
        expect(
            isXGrokConversationItemsEndpoint(`https://example.test${canonical.pathname}${canonical.search}`),
        ).toBeFalse();
        expect(
            isXGrokConversationItemsEndpoint(
                `https://x.com/i/api/graphql/wrong-operation/GrokConversationItemsByRestId${canonical.search}`,
            ),
        ).toBeFalse();
        expect(isXGrokConversationItemsEndpoint(`${canonical.toString()}/suffix`)).toBeFalse();
    });

    it('should require one valid variables query and one features query with no extras', () => {
        const canonical = new URL(buildXGrokConversationItemsUrl(CONVERSATION_ID));
        const withoutFeatures = new URL(canonical);
        withoutFeatures.searchParams.delete('features');
        expect(isXGrokConversationItemsEndpoint(withoutFeatures.toString())).toBeFalse();

        const invalidVariables = new URL(canonical);
        invalidVariables.searchParams.set('variables', JSON.stringify({ restId: CONVERSATION_ID, extra: true }));
        expect(isXGrokConversationItemsEndpoint(invalidVariables.toString())).toBeFalse();

        const invalidFeatures = new URL(canonical);
        invalidFeatures.searchParams.set('features', JSON.stringify({ enabled: 'yes' }));
        expect(isXGrokConversationItemsEndpoint(invalidFeatures.toString())).toBeFalse();

        const extraQuery = new URL(canonical);
        extraQuery.searchParams.set('extra', 'true');
        expect(isXGrokConversationItemsEndpoint(extraQuery.toString())).toBeFalse();

        const duplicateVariables = new URL(canonical);
        duplicateVariables.searchParams.append('variables', canonical.searchParams.get('variables') ?? '');
        expect(isXGrokConversationItemsEndpoint(duplicateVariables.toString())).toBeFalse();
    });
});
