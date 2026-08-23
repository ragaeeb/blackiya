import { describe, expect, it } from 'bun:test';
import {
    createZaiAlternateBranchFixtures,
    ZAI_ALTERNATE_ASSISTANT_MESSAGE_ID,
    ZAI_ASSISTANT_MESSAGE_ID,
    ZAI_CONVERSATION_ID,
    ZAI_USER_MESSAGE_ID,
    zaiDetailPayloadFixture,
    zaiMessagesBatchPayloadFixture,
} from './fixtures/har-derived';
import { evaluateZaiReadiness } from './readiness';
import { buildZaiMessagesBatchRequest } from './requests';
import { ZaiConversationResponseAssembler } from './response-assembler';

const detailUrl = `https://chat.z.ai/api/v1/chats/${ZAI_CONVERSATION_ID}`;
const batchUrl = `${detailUrl}/messages/batch`;

const createAssemblerInput = (input: {
    url: string;
    method: 'GET' | 'POST';
    response: unknown;
    requestBody?: string;
}) => ({
    url: input.url,
    method: input.method,
    responseText: JSON.stringify(input.response),
    ...(input.requestBody === undefined ? {} : { requestBody: input.requestBody }),
});

const canonicalBatchBody = (detail: unknown = zaiDetailPayloadFixture) =>
    buildZaiMessagesBatchRequest(detail)?.body ?? '';

const ingestDetail = (assembler: ZaiConversationResponseAssembler, detail: unknown = zaiDetailPayloadFixture) =>
    assembler.ingest(createAssemblerInput({ url: detailUrl, method: 'GET', response: detail }));

const ingestBatch = (
    assembler: ZaiConversationResponseAssembler,
    response: unknown = zaiMessagesBatchPayloadFixture,
    requestBody = canonicalBatchBody(),
) =>
    assembler.ingest(
        createAssemblerInput({
            url: batchUrl,
            method: 'POST',
            requestBody,
            response,
        }),
    );

describe('ZaiConversationResponseAssembler', () => {
    it('should assemble only the canonical detail, requested IDs, and terminal batch sequence', () => {
        const assembler = new ZaiConversationResponseAssembler();

        expect(ingestDetail(assembler)).toBeNull();
        const result = ingestBatch(assembler);

        expect(result).toMatchObject({
            title: 'Synthetic Z.ai Conversation',
            conversation_id: ZAI_CONVERSATION_ID,
            current_node: ZAI_ASSISTANT_MESSAGE_ID,
        });
        expect(evaluateZaiReadiness(result!)).toMatchObject({ ready: true, terminal: true });
        expect(JSON.stringify(result?.raw_payload)).toBe(
            JSON.stringify({ detail: zaiDetailPayloadFixture, messages_batch: zaiMessagesBatchPayloadFixture }),
        );
    });

    it('should retain a canonical batch that finishes before its detail response', () => {
        const assembler = new ZaiConversationResponseAssembler();

        expect(ingestBatch(assembler)).toBeNull();
        expect(ingestDetail(assembler)?.conversation_id).toBe(ZAI_CONVERSATION_ID);
    });

    it('should reject partial batch responses and batch requests missing detail IDs', () => {
        const partialResponse = structuredClone(zaiMessagesBatchPayloadFixture);
        Reflect.deleteProperty(partialResponse.data, ZAI_ASSISTANT_MESSAGE_ID);
        const missingRequestedId = JSON.stringify({ ids: [ZAI_USER_MESSAGE_ID] });

        const responseAssembler = new ZaiConversationResponseAssembler();
        ingestDetail(responseAssembler);
        expect(ingestBatch(responseAssembler, partialResponse)).toBeNull();

        const requestAssembler = new ZaiConversationResponseAssembler();
        ingestDetail(requestAssembler);
        expect(ingestBatch(requestAssembler, zaiMessagesBatchPayloadFixture, missingRequestedId)).toBeNull();
        expect(
            ingestBatch(
                requestAssembler,
                zaiMessagesBatchPayloadFixture,
                JSON.stringify({ ids: [ZAI_USER_MESSAGE_ID, ZAI_ASSISTANT_MESSAGE_ID], unexpected: true }),
            ),
        ).toBeNull();
    });

    it('should retain no exportable result while the declared assistant is incomplete', () => {
        const batch = structuredClone(zaiMessagesBatchPayloadFixture);
        batch.data[ZAI_ASSISTANT_MESSAGE_ID].done = false;
        const assembler = new ZaiConversationResponseAssembler();

        ingestDetail(assembler);

        expect(ingestBatch(assembler, batch)).toBeNull();
    });

    it('should use the declared current leaf instead of a newer inactive alternate branch', () => {
        const { detail, batch } = createZaiAlternateBranchFixtures();
        const assembler = new ZaiConversationResponseAssembler();

        expect(ingestDetail(assembler, detail)).toBeNull();
        const result = ingestBatch(assembler, batch, canonicalBatchBody(detail));

        expect(result?.current_node).toBe(ZAI_ASSISTANT_MESSAGE_ID);
        expect(result?.mapping[ZAI_ASSISTANT_MESSAGE_ID]?.message?.end_turn).toBeTrue();
        expect(result?.mapping[ZAI_ALTERNATE_ASSISTANT_MESSAGE_ID]?.message?.end_turn).toBeFalse();
        expect(evaluateZaiReadiness(result!)).toMatchObject({ ready: true, terminal: true });
    });

    it('should reject mismatched detail, URL, request, and batch identities', () => {
        const otherConversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const mismatchedBatch = structuredClone(zaiMessagesBatchPayloadFixture);
        mismatchedBatch.chat_id = otherConversationId;
        for (const message of Object.values(mismatchedBatch.data)) {
            message.chat_id = otherConversationId;
        }

        const payloadAssembler = new ZaiConversationResponseAssembler();
        ingestDetail(payloadAssembler);
        expect(ingestBatch(payloadAssembler, mismatchedBatch)).toBeNull();

        const urlAssembler = new ZaiConversationResponseAssembler();
        ingestDetail(urlAssembler);
        expect(
            urlAssembler.ingest(
                createAssemblerInput({
                    url: `https://chat.z.ai/api/v1/chats/${otherConversationId}/messages/batch`,
                    method: 'POST',
                    requestBody: canonicalBatchBody(),
                    response: zaiMessagesBatchPayloadFixture,
                }),
            ),
        ).toBeNull();

        const requestAssembler = new ZaiConversationResponseAssembler();
        ingestDetail(requestAssembler);
        expect(
            ingestBatch(
                requestAssembler,
                zaiMessagesBatchPayloadFixture,
                JSON.stringify({ ids: [ZAI_USER_MESSAGE_ID, otherConversationId] }),
            ),
        ).toBeNull();
    });

    it('should require matching finite message revisions across detail and batch responses', () => {
        const mismatchedBatch = structuredClone(zaiMessagesBatchPayloadFixture);
        mismatchedBatch.message_version += 1;
        const mismatchedAssembler = new ZaiConversationResponseAssembler();
        ingestDetail(mismatchedAssembler);
        expect(ingestBatch(mismatchedAssembler, mismatchedBatch)).toBeNull();

        const missingRevisionDetail = structuredClone(zaiDetailPayloadFixture) as Record<string, unknown>;
        Reflect.deleteProperty(missingRevisionDetail, 'message_version');
        const missingAssembler = new ZaiConversationResponseAssembler();
        ingestDetail(missingAssembler, missingRevisionDetail);
        expect(ingestBatch(missingAssembler)).toBeNull();
    });

    it('should reject a declared current node that is not a leaf', () => {
        const detail = structuredClone(zaiDetailPayloadFixture);
        detail.chat.history.currentId = ZAI_USER_MESSAGE_ID;
        const assembler = new ZaiConversationResponseAssembler();

        ingestDetail(assembler, detail);

        expect(ingestBatch(assembler, zaiMessagesBatchPayloadFixture, canonicalBatchBody(detail))).toBeNull();
    });

    it('should expire retained detail responses at the configured TTL', () => {
        let now = 100;
        const assembler = new ZaiConversationResponseAssembler({ maxAgeMs: 10, now: () => now });

        ingestDetail(assembler);
        now = 110;

        expect(ingestBatch(assembler)).toBeNull();
    });

    it('should schedule expiry pruning without requiring another assembler access', () => {
        let now = 100;
        let scheduledPrune: (() => void) | undefined;
        const assembler = new ZaiConversationResponseAssembler({
            maxAgeMs: 10,
            now: () => now,
            schedulePrune: (callback) => {
                scheduledPrune = callback;
                return 1;
            },
            cancelPrune: () => undefined,
        });
        ingestDetail(assembler);
        expect(scheduledPrune).toBeDefined();

        now = 110;
        scheduledPrune?.();
        now = 100;

        expect(ingestBatch(assembler)).toBeNull();
    });

    it('should reject detail responses over the configured byte bound', () => {
        const responseText = JSON.stringify(zaiDetailPayloadFixture);
        const responseBytes = new TextEncoder().encode(responseText).byteLength;
        const assembler = new ZaiConversationResponseAssembler({ maxBytesPerEntry: responseBytes - 1 });

        expect(assembler.ingest({ url: detailUrl, method: 'GET', responseText })).toBeNull();
        expect(ingestBatch(assembler)).toBeNull();
    });

    it('should evict the oldest detail response when the entry bound is exceeded', () => {
        const otherConversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const otherDetail = JSON.parse(
            JSON.stringify(zaiDetailPayloadFixture).replaceAll(ZAI_CONVERSATION_ID, otherConversationId),
        ) as unknown;
        const assembler = new ZaiConversationResponseAssembler({ maxEntries: 1 });

        ingestDetail(assembler);
        assembler.ingest(
            createAssemblerInput({
                url: `https://chat.z.ai/api/v1/chats/${otherConversationId}`,
                method: 'GET',
                response: otherDetail,
            }),
        );

        expect(ingestBatch(assembler)).toBeNull();
    });
});
