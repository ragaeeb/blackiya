import { describe, expect, it } from 'bun:test';
import {
    getXGrokGraphqlContext,
    maybeCaptureXGrokGraphqlContext,
    resetXGrokGraphqlContext,
} from '@/entrypoints/interceptor/x-grok-graphql-context-store';

describe('x-grok-graphql-context-store', () => {
    it('should capture x-grok detail query id and features from GraphQL request url', () => {
        resetXGrokGraphqlContext();
        maybeCaptureXGrokGraphqlContext(
            'https://x.com/i/api/graphql/n2bhau0B2DSY6R_bLolgSg/GrokConversationItemsByRestId?variables=%7B%22restId%22%3A%222029114150362702208%22%7D&features=%7B%22responsive_web_grok_annotations_enabled%22%3Atrue%7D',
        );

        const context = getXGrokGraphqlContext();
        expect(context?.queryId).toBe('n2bhau0B2DSY6R_bLolgSg');
        expect(context?.features).toBe('{"responsive_web_grok_annotations_enabled":true}');
    });

    it('should ignore non x-grok detail urls', () => {
        resetXGrokGraphqlContext();
        maybeCaptureXGrokGraphqlContext(
            'https://x.com/i/api/graphql/9Hyh5D4-WXLnExZkONSkZg/GrokHistory?variables=%7B%7D',
        );
        expect(getXGrokGraphqlContext()).toBeUndefined();
    });
});
