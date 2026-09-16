import { describe, expect, it } from 'bun:test';
import {
    attachMetaArtifactSandbox,
    createMetaDetailFixture,
    createMetaMessagesOnlyFixture,
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

    it('should join captured artifact bodies into a ready conversation without blocking export', () => {
        const markdownUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const payload = createMetaDetailFixture();
        attachMetaArtifactSandbox(payload, {
            uuid: markdownUuid,
            artifact_type: 'MARKDOWN',
            file_extension: 'md',
            title: 'REPORT',
        });
        const assembler = new MetaGraphqlResponseAssembler();
        expect(assembler.ingest(detailBody(), JSON.stringify(payload))).not.toBeNull();

        assembler.ingestArtifact(markdownUuid, 'computed from 4.4M edges, teacher/student');
        const ready = assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID);

        expect(ready?.mapping['synthetic-assistant-message']?.message?.content.parts).toEqual([
            'Synthetic terminal answer.',
            'computed from 4.4M edges, teacher/student',
        ]);
    });

    it('should return a closed messages-only GraphQL response as ready-terminal', () => {
        const assembler = new MetaGraphqlResponseAssembler();
        const requestBody = JSON.stringify({
            doc_id: 'synthetic-messages-document',
            variables: { conversationId: SYNTHETIC_META_CONVERSATION_ID },
        });
        const responseText = JSON.stringify(createMetaMessagesOnlyFixture());

        const result = assembler.ingest(requestBody, responseText);

        expect(result?.conversation_id).toBe(SYNTHETIC_META_CONVERSATION_ID);
        expect(result?.title).toBe('');
        expect(assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID)).toEqual(result);
        expect(
            assembler.ingest(
                JSON.stringify({
                    doc_id: DETAIL_DOCUMENT_ID,
                    variables: { id: SYNTHETIC_META_CONVERSATION_ID },
                }),
                JSON.stringify({
                    data: {
                        conversation: {
                            id: SYNTHETIC_META_CONVERSATION_ID,
                            title: 'Synthetic Meta Muse Conversation',
                            type: 'CHAT',
                        },
                    },
                }),
            ),
        ).toBeNull();
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

    it('should count artifact bytes toward the shared total budget', () => {
        const artifactUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const first = JSON.stringify(createMetaDetailFixture());
        const secondPayload = withConversationId(createMetaDetailFixture(), SECOND_CONVERSATION_ID);
        attachMetaArtifactSandbox(secondPayload, {
            uuid: artifactUuid,
            artifact_type: 'MARKDOWN',
            file_extension: 'md',
            title: 'REPORT',
        });
        const second = JSON.stringify(secondPayload);
        const firstBytes = new TextEncoder().encode(first).byteLength;
        const secondBytes = new TextEncoder().encode(second).byteLength;
        const artifact = 'x'.repeat(64);
        const artifactBytes = new TextEncoder().encode(artifact).byteLength;
        const assembler = new MetaGraphqlResponseAssembler({
            maxBytesPerEntry: Math.max(firstBytes, secondBytes, artifactBytes),
            maxTotalBytes: firstBytes + secondBytes + artifactBytes - 1,
        });

        expect(assembler.ingest(detailBody(), first)).not.toBeNull();
        expect(assembler.ingest(detailBody(SECOND_CONVERSATION_ID), second)).not.toBeNull();
        assembler.ingestArtifact(artifactUuid, artifact);

        expect(assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID)).toBeNull();
        expect(
            assembler.getReadyConversation(SECOND_CONVERSATION_ID)?.mapping['synthetic-assistant-message']?.message
                ?.content.parts,
        ).toEqual(['Synthetic terminal answer.', artifact]);
    });

    it('should replace artifact bytes without leaking the previous size into the total budget', () => {
        const firstArtifactUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const secondArtifactUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        const payload = createMetaDetailFixture();
        attachMetaArtifactSandbox(payload, {
            uuid: firstArtifactUuid,
            artifact_type: 'MARKDOWN',
            file_extension: 'md',
            title: 'REPORT',
        });
        attachMetaArtifactSandbox(payload, {
            uuid: secondArtifactUuid,
            artifact_type: 'DOCUMENT',
            file_extension: 'json',
            title: 'Report',
        });
        const responseText = JSON.stringify(payload);
        const responseBytes = new TextEncoder().encode(responseText).byteLength;
        const smallArtifact = 'small-artifact';
        const largeArtifact = 'x'.repeat(64);
        const smallBytes = new TextEncoder().encode(smallArtifact).byteLength;
        const largeBytes = new TextEncoder().encode(largeArtifact).byteLength;
        const assembler = new MetaGraphqlResponseAssembler({
            maxBytesPerEntry: Math.max(responseBytes, largeBytes),
            maxTotalBytes: responseBytes + smallBytes + largeBytes,
        });

        expect(assembler.ingest(detailBody(), responseText)).not.toBeNull();
        assembler.ingestArtifact(firstArtifactUuid, largeArtifact);
        assembler.ingestArtifact(firstArtifactUuid, smallArtifact);
        assembler.ingestArtifact(secondArtifactUuid, largeArtifact);

        expect(assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID)?.mapping[
            'synthetic-assistant-message'
        ]?.message?.content.parts).toEqual(['Synthetic terminal answer.', smallArtifact, largeArtifact]);
    });

    it('should drop expired artifact bytes so a later conversation can use the budget', () => {
        const artifactUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        let now = 100;
        const responseText = JSON.stringify(createMetaDetailFixture());
        const responseBytes = new TextEncoder().encode(responseText).byteLength;
        const assembler = new MetaGraphqlResponseAssembler({
            maxAgeMs: 10,
            now: () => now,
            maxBytesPerEntry: responseBytes,
            maxTotalBytes: responseBytes,
        });

        assembler.ingestArtifact(artifactUuid, 'expired-artifact-bytes');
        now = 110;
        expect(assembler.ingest(detailBody(), responseText)).not.toBeNull();
        expect(assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID)).not.toBeNull();
    });

    it('should evict the oldest artifact when the artifact count bound is exceeded', () => {
        const firstArtifactUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const secondArtifactUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        const payload = createMetaDetailFixture();
        attachMetaArtifactSandbox(payload, {
            uuid: firstArtifactUuid,
            artifact_type: 'MARKDOWN',
            file_extension: 'md',
            title: 'REPORT',
        });
        attachMetaArtifactSandbox(payload, {
            uuid: secondArtifactUuid,
            artifact_type: 'DOCUMENT',
            file_extension: 'json',
            title: 'Report',
        });
        const assembler = new MetaGraphqlResponseAssembler({ maxPagesPerEntry: 1 });
        expect(assembler.ingest(detailBody(), JSON.stringify(payload))).not.toBeNull();
        assembler.ingestArtifact(firstArtifactUuid, 'first-artifact');
        assembler.ingestArtifact(secondArtifactUuid, 'second-artifact');

        expect(assembler.getReadyConversation(SYNTHETIC_META_CONVERSATION_ID)?.mapping[
            'synthetic-assistant-message'
        ]?.message?.content.parts).toEqual(['Synthetic terminal answer.', 'second-artifact']);
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
