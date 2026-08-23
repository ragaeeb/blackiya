import { describe, expect, it } from 'bun:test';
import { createMetaDetailFixture, SYNTHETIC_META_CONVERSATION_ID } from './fixtures/conversation';
import { metaAdapter } from './index';

describe('Meta Muse adapter', () => {
    it('should match only Meta AI origins', () => {
        expect(metaAdapter.isPlatformUrl('https://www.meta.ai/prompt/11111111-1111-4111-8111-111111111111')).toBeTrue();
        expect(metaAdapter.isPlatformUrl('https://meta.ai/prompt/11111111-1111-4111-8111-111111111111')).toBeTrue();
        expect(metaAdapter.isPlatformUrl('http://www.meta.ai/prompt/11111111-1111-4111-8111-111111111111')).toBeFalse();
        expect(
            metaAdapter.isPlatformUrl('https://www.meta.ai.evil.example/prompt/11111111-1111-4111-8111-111111111111'),
        ).toBeFalse();
        expect(metaAdapter.isPlatformUrl('not a url')).toBeFalse();
    });

    it('should extract synthetic UUIDs only from /prompt conversation URLs', () => {
        expect(
            metaAdapter.extractConversationId(
                `https://www.meta.ai/prompt/${SYNTHETIC_META_CONVERSATION_ID}?synthetic=true`,
            ),
        ).toBe(SYNTHETIC_META_CONVERSATION_ID);
        expect(metaAdapter.extractConversationId('https://www.meta.ai/prompt/not-a-uuid')).toBeNull();
        expect(
            metaAdapter.extractConversationId(`https://example.com/prompt/${SYNTHETIC_META_CONVERSATION_ID}`),
        ).toBeNull();
    });

    it('should parse only the GraphQL endpoint and expose terminal readiness', () => {
        const payload = createMetaDetailFixture();
        const parsed = metaAdapter.parseInterceptedData(JSON.stringify(payload), 'https://www.meta.ai/api/graphql');

        expect(parsed?.conversation_id).toBe(SYNTHETIC_META_CONVERSATION_ID);
        expect(metaAdapter.evaluateReadiness?.(parsed!)).toMatchObject({
            ready: true,
            terminal: true,
            reason: 'terminal',
        });
        expect(
            metaAdapter.parseInterceptedData(JSON.stringify(payload), 'https://www.meta.ai/api/analytics'),
        ).toBeNull();
    });

    it('should disable URL-only detail capture for the multiplexed GraphQL route', () => {
        expect(metaAdapter.isConversationDetailRequest?.('https://www.meta.ai/api/graphql', 'POST')).toBeFalse();
    });

    it('should create a bounded sanitized filename', () => {
        const parsed = metaAdapter.parseInterceptedData(
            JSON.stringify(createMetaDetailFixture()),
            'https://www.meta.ai/api/graphql',
        );

        expect(parsed).not.toBeNull();
        expect(metaAdapter.formatFilename(parsed!)).toMatch(/^Synthetic_Meta_Muse_Conversation_/);
        expect(metaAdapter.formatFilename(parsed!).length).toBeLessThanOrEqual(100);
    });
});
