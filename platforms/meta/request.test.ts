import { describe, expect, it } from 'bun:test';
import { SYNTHETIC_META_CONVERSATION_ID } from './fixtures/conversation';
import {
    buildMetaConversationDetailRequest,
    buildMetaConversationPaginationRequest,
    extractMetaGraphqlRequestContext,
    META_GRAPHQL_ENDPOINT,
} from './request';

const DETAIL_DOCUMENT_ID = 'synthetic-detail-document';
const PAGINATION_DOCUMENT_ID = 'synthetic-pagination-document';

describe('Meta Muse GraphQL request helpers', () => {
    it('should build the HAR-derived persisted detail POST with synthetic context', () => {
        const request = buildMetaConversationDetailRequest(SYNTHETIC_META_CONVERSATION_ID, {
            documentId: DETAIL_DOCUMENT_ID,
        });

        expect(request).not.toBeNull();
        expect(request?.url).toBe(META_GRAPHQL_ENDPOINT);
        expect(request?.method).toBe('POST');
        expect(request?.credentials).toBe('include');
        expect(request?.headers).toEqual({ 'content-type': 'application/json' });
        expect(JSON.parse(request?.body ?? '')).toEqual({
            doc_id: DETAIL_DOCUMENT_ID,
            variables: {
                id: SYNTHETIC_META_CONVERSATION_ID,
                includeMessageList: true,
            },
        });
    });

    it('should build backward pagination from the Relay conversation id and cursor', () => {
        const request = buildMetaConversationPaginationRequest(
            {
                conversationId: SYNTHETIC_META_CONVERSATION_ID,
                before: 'synthetic-before-cursor',
                last: 20,
            },
            { documentId: PAGINATION_DOCUMENT_ID },
        );

        expect(request).not.toBeNull();
        expect(JSON.parse(request?.body ?? '')).toEqual({
            doc_id: PAGINATION_DOCUMENT_ID,
            variables: {
                before: 'synthetic-before-cursor',
                conversationId: SYNTHETIC_META_CONVERSATION_ID,
                last: 20,
            },
        });
    });

    it('should classify live persisted-query context without retaining unrelated fields', () => {
        expect(
            extractMetaGraphqlRequestContext(
                JSON.stringify({
                    doc_id: DETAIL_DOCUMENT_ID,
                    variables: { id: SYNTHETIC_META_CONVERSATION_ID, includeMessageList: true },
                    syntheticIgnoredField: 'ignored',
                }),
            ),
        ).toEqual({
            kind: 'conversation-detail',
            conversationId: SYNTHETIC_META_CONVERSATION_ID,
            documentId: DETAIL_DOCUMENT_ID,
        });

        expect(
            extractMetaGraphqlRequestContext(
                JSON.stringify({
                    doc_id: PAGINATION_DOCUMENT_ID,
                    variables: {
                        before: 'synthetic-before-cursor',
                        conversationId: SYNTHETIC_META_CONVERSATION_ID,
                        last: 20,
                    },
                }),
            ),
        ).toEqual({
            kind: 'conversation-pagination',
            conversationId: SYNTHETIC_META_CONVERSATION_ID,
            documentId: PAGINATION_DOCUMENT_ID,
            before: 'synthetic-before-cursor',
            last: 20,
        });
    });

    it('should reject malformed ids, document context, cursors, and page sizes', () => {
        expect(
            buildMetaConversationDetailRequest('not-a-conversation-id', { documentId: DETAIL_DOCUMENT_ID }),
        ).toBeNull();
        expect(
            buildMetaConversationDetailRequest(SYNTHETIC_META_CONVERSATION_ID, { documentId: 'bad value' }),
        ).toBeNull();
        expect(
            buildMetaConversationPaginationRequest(
                { conversationId: SYNTHETIC_META_CONVERSATION_ID, before: '', last: 20 },
                { documentId: PAGINATION_DOCUMENT_ID },
            ),
        ).toBeNull();
        expect(
            buildMetaConversationPaginationRequest(
                { conversationId: SYNTHETIC_META_CONVERSATION_ID, before: 'synthetic-cursor', last: 0 },
                { documentId: PAGINATION_DOCUMENT_ID },
            ),
        ).toBeNull();
        expect(extractMetaGraphqlRequestContext('{')).toBeNull();
    });
});
