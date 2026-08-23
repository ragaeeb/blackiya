import { describe, expect, it } from 'bun:test';
import {
    createMetaDetailFixture,
    createMetaOlderPageFixture,
    SYNTHETIC_META_CONVERSATION_ID,
} from './fixtures/conversation';
import { buildMetaConversationDetailRequest, buildMetaConversationPaginationRequest } from './request';
import { MetaGraphqlResponseAssembler } from './response-assembler';

const DETAIL_DOCUMENT_ID = 'synthetic-detail-document';
const PAGINATION_DOCUMENT_ID = 'synthetic-pagination-document';
const SECOND_CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';

const detailBody = (conversationId = SYNTHETIC_META_CONVERSATION_ID) =>
    buildMetaConversationDetailRequest(conversationId, { documentId: DETAIL_DOCUMENT_ID })?.body ?? '';

const paginationBody = (before = 'synthetic-before-cursor', conversationId = SYNTHETIC_META_CONVERSATION_ID) =>
    buildMetaConversationPaginationRequest({ conversationId, before, last: 20 }, { documentId: PAGINATION_DOCUMENT_ID })
        ?.body ?? '';

const withConversationId = <T>(fixture: T, conversationId: string): T => {
    const serialized = JSON.stringify(fixture).replaceAll(SYNTHETIC_META_CONVERSATION_ID, conversationId);
    return JSON.parse(serialized) as T;
};

const createOlderPage = (id: string, hasPreviousPage: boolean, startCursor: string | null): unknown => {
    const fixture = structuredClone(createMetaOlderPageFixture()) as unknown as {
        data: {
            conversation: {
                messages: {
                    edges: Array<{ node: { id: string } }>;
                    pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
                };
            };
        };
    };
    const conversation = fixture.data.conversation;
    conversation.messages.edges[0]!.node.id = id;
    conversation.messages.pageInfo.hasPreviousPage = hasPreviousPage;
    conversation.messages.pageInfo.startCursor = startCursor;
    return fixture;
};

describe('MetaGraphqlResponseAssembler', () => {
    it('should return and retain a complete ready-terminal initial response', () => {
        const assembler = new MetaGraphqlResponseAssembler();
        const responseText = JSON.stringify(createMetaDetailFixture());

        const result = assembler.ingest(detailBody(), responseText);

        expect(result?.conversation_id).toBe(SYNTHETIC_META_CONVERSATION_ID);
        expect(JSON.stringify(result?.raw_payload)).toBe(JSON.stringify(createMetaDetailFixture()));
        expect(assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID)).toEqual(result);
    });

    it('should assemble cursor-ordered pagination and return only after history is complete', () => {
        const assembler = new MetaGraphqlResponseAssembler();
        const initial = JSON.stringify(createMetaDetailFixture({ hasPreviousPage: true }));
        const firstPage = JSON.stringify(createOlderPage('synthetic-middle-message', true, 'synthetic-next-cursor'));
        const oldestPage = JSON.stringify(createOlderPage('synthetic-oldest-message', false, null));

        expect(assembler.ingest(detailBody(), initial)).toBeNull();
        expect(assembler.ingest(paginationBody(), firstPage)).toBeNull();
        const result = assembler.ingest(paginationBody('synthetic-next-cursor'), oldestPage);

        expect(Object.keys(result?.mapping ?? {})).toEqual([
            'synthetic-oldest-message',
            'synthetic-middle-message',
            'synthetic-user-message',
            'synthetic-assistant-message',
        ]);
        expect(JSON.stringify(result?.raw_payload)).toBe(
            JSON.stringify({
                initial_response: createMetaDetailFixture({ hasPreviousPage: true }),
                pagination_responses: [
                    createOlderPage('synthetic-middle-message', true, 'synthetic-next-cursor'),
                    createOlderPage('synthetic-oldest-message', false, null),
                ],
            }),
        );
    });

    it('should retain pagination that finishes before its initial response', () => {
        const assembler = new MetaGraphqlResponseAssembler();
        const initial = JSON.stringify(createMetaDetailFixture({ hasPreviousPage: true }));
        const page = JSON.stringify(createMetaOlderPageFixture());

        expect(assembler.ingest(paginationBody(), page)).toBeNull();
        expect(assembler.ingest(detailBody(), initial)?.conversation_id).toBe(SYNTHETIC_META_CONVERSATION_ID);
    });

    it('should retain cursor pages that finish in reverse order and assemble the canonical chain', () => {
        const assembler = new MetaGraphqlResponseAssembler();
        const initial = JSON.stringify(createMetaDetailFixture({ hasPreviousPage: true }));
        const firstPage = JSON.stringify(createOlderPage('synthetic-middle-message', true, 'synthetic-next-cursor'));
        const oldestPage = JSON.stringify(createOlderPage('synthetic-oldest-message', false, null));

        expect(assembler.ingest(paginationBody('synthetic-next-cursor'), oldestPage)).toBeNull();
        expect(assembler.ingest(paginationBody(), firstPage)).toBeNull();
        const result = assembler.ingest(detailBody(), initial);

        expect(Object.keys(result?.mapping ?? {})).toEqual([
            'synthetic-oldest-message',
            'synthetic-middle-message',
            'synthetic-user-message',
            'synthetic-assistant-message',
        ]);
    });

    it('should ignore retained pages whose request cursor is outside the canonical chain', () => {
        const assembler = new MetaGraphqlResponseAssembler();
        const initial = JSON.stringify(createMetaDetailFixture({ hasPreviousPage: true }));
        const page = JSON.stringify(createMetaOlderPageFixture());

        expect(assembler.ingest(paginationBody('unexpected-cursor'), page)).toBeNull();
        expect(assembler.ingest(detailBody(), initial)).toBeNull();
        expect(assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID)).toBeNull();
        expect(assembler.ingest(paginationBody(), page)?.conversation_id).toBe(SYNTHETIC_META_CONVERSATION_ID);
    });

    it('should reject malformed bodies, malformed responses, and response ID mismatches without corrupting state', () => {
        const assembler = new MetaGraphqlResponseAssembler();
        const initial = JSON.stringify(createMetaDetailFixture({ hasPreviousPage: true }));

        expect(assembler.ingest('{', initial)).toBeNull();
        expect(assembler.ingest(detailBody(), '{')).toBeNull();
        expect(assembler.ingest(detailBody(SECOND_CONVERSATION_ID), initial)).toBeNull();
        expect(assembler.ingest(detailBody(), initial)).toBeNull();
        expect(
            assembler.ingest(paginationBody(), JSON.stringify(createMetaOlderPageFixture(SECOND_CONVERSATION_ID))),
        ).toBeNull();
        expect(assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID)).toBeNull();
        expect(assembler.ingest(paginationBody(), JSON.stringify(createMetaOlderPageFixture()))).not.toBeNull();
    });

    it('should retain non-terminal responses without returning them as exportable data', () => {
        const assembler = new MetaGraphqlResponseAssembler();
        const inProgress = JSON.stringify(createMetaDetailFixture({ assistantStreamingState: 'STREAMING' }));

        expect(assembler.ingest(detailBody(), inProgress)).toBeNull();
        expect(assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID)).toBeNull();
    });

    it('should expire retained response text at the configured TTL', () => {
        let now = 100;
        const assembler = new MetaGraphqlResponseAssembler({ maxAgeMs: 10, now: () => now });
        const responseText = JSON.stringify(createMetaDetailFixture());

        expect(assembler.ingest(detailBody(), responseText)).not.toBeNull();
        now = 110;
        expect(assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID)).toBeNull();
    });

    it('should schedule expiry pruning without requiring another assembler access', () => {
        let now = 100;
        let scheduledPrune: (() => void) | undefined;
        const assembler = new MetaGraphqlResponseAssembler({
            maxAgeMs: 10,
            now: () => now,
            schedulePrune: (callback) => {
                scheduledPrune = callback;
                return 1;
            },
            cancelPrune: () => undefined,
        });
        expect(assembler.ingest(detailBody(), JSON.stringify(createMetaDetailFixture()))).not.toBeNull();
        expect(scheduledPrune).toBeDefined();

        now = 110;
        scheduledPrune?.();
        now = 100;

        expect(assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID)).toBeNull();
    });

    it('should clear all retained response text explicitly', () => {
        const assembler = new MetaGraphqlResponseAssembler();
        const responseText = JSON.stringify(createMetaDetailFixture());

        expect(assembler.ingest(detailBody(), responseText)).not.toBeNull();
        assembler.clear();
        expect(assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID)).toBeNull();
    });

    it('should evict the oldest conversation when the entry bound is exceeded', () => {
        const assembler = new MetaGraphqlResponseAssembler({ maxEntries: 1 });
        const first = JSON.stringify(createMetaDetailFixture());
        const second = JSON.stringify(withConversationId(createMetaDetailFixture(), SECOND_CONVERSATION_ID));

        expect(assembler.ingest(detailBody(), first)).not.toBeNull();
        expect(assembler.ingest(detailBody(SECOND_CONVERSATION_ID), second)).not.toBeNull();
        expect(assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID)).toBeNull();
        expect(assembler.getReadyConversation(SECOND_CONVERSATION_ID)).not.toBeNull();
    });

    it('should reject response text that exceeds the per-conversation byte bound', () => {
        const responseText = JSON.stringify(createMetaDetailFixture({ assistantContent: '🙂'.repeat(16) }));
        const assembler = new MetaGraphqlResponseAssembler({ maxBytesPerEntry: responseText.length });

        expect(assembler.ingest(detailBody(), responseText)).toBeNull();
        expect(assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID)).toBeNull();
    });

    it('should evict older conversations to enforce the total byte bound', () => {
        const first = JSON.stringify(createMetaDetailFixture());
        const second = JSON.stringify(withConversationId(createMetaDetailFixture(), SECOND_CONVERSATION_ID));
        const responseBytes = new TextEncoder().encode(first).byteLength;
        const assembler = new MetaGraphqlResponseAssembler({
            maxBytesPerEntry: responseBytes,
            maxTotalBytes: responseBytes * 2 - 1,
        });

        expect(assembler.ingest(detailBody(), first)).not.toBeNull();
        expect(assembler.ingest(detailBody(SECOND_CONVERSATION_ID), second)).not.toBeNull();
        expect(assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID)).toBeNull();
        expect(assembler.getReadyConversation(SECOND_CONVERSATION_ID)).not.toBeNull();
    });

    it('should bound retained pagination page count without returning partial history', () => {
        const assembler = new MetaGraphqlResponseAssembler({ maxPagesPerEntry: 1 });
        const initial = JSON.stringify(createMetaDetailFixture({ hasPreviousPage: true }));
        const firstPage = JSON.stringify(createOlderPage('synthetic-middle-message', true, 'synthetic-next-cursor'));
        const oldestPage = JSON.stringify(createOlderPage('synthetic-oldest-message', false, null));

        expect(assembler.ingest(detailBody(), initial)).toBeNull();
        expect(assembler.ingest(paginationBody(), firstPage)).toBeNull();
        expect(assembler.ingest(paginationBody('synthetic-next-cursor'), oldestPage)).toBeNull();
        expect(assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID)).toBeNull();
    });
});
