import { describe, expect, it } from 'bun:test';
import {
    ZAI_ASSISTANT_MESSAGE_ID,
    ZAI_CONVERSATION_ID,
    ZAI_USER_MESSAGE_ID,
    zaiDetailPayloadFixture,
    zaiMessagesBatchPayloadFixture,
} from './fixtures/har-derived';
import { mergeZaiConversationPayloads, parseZaiConversationDetail, parseZaiMessagesBatch } from './parser';

describe('Z.ai HAR-derived payload parsing', () => {
    it('should preserve a complete detail response while marking its unloaded assistant stub in progress', () => {
        const raw = structuredClone(zaiDetailPayloadFixture);
        const parsed = parseZaiConversationDetail(raw, ZAI_CONVERSATION_ID);

        expect(parsed?.title).toBe('Synthetic Z.ai Conversation');
        expect(parsed?.conversation_id).toBe(ZAI_CONVERSATION_ID);
        expect(parsed?.current_node).toBe(ZAI_ASSISTANT_MESSAGE_ID);
        expect(parsed?.mapping[ZAI_ASSISTANT_MESSAGE_ID]?.message).toMatchObject({
            status: 'in_progress',
            end_turn: false,
        });
        expect(JSON.stringify(parsed?.raw_payload)).toBe(JSON.stringify(raw));
    });

    it('should parse terminal batch messages and retain only text blocks in normalized assistant text', () => {
        const raw = structuredClone(zaiMessagesBatchPayloadFixture);
        const parsed = parseZaiMessagesBatch(raw, ZAI_CONVERSATION_ID);
        const assistant = parsed?.mapping[ZAI_ASSISTANT_MESSAGE_ID]?.message;

        expect(assistant).toMatchObject({
            author: { role: 'assistant' },
            status: 'finished_successfully',
            end_turn: true,
            content: {
                content_type: 'text',
                parts: ['Synthetic interim answer.', 'Synthetic terminal answer.'],
            },
        });
        expect(parsed?.mapping[ZAI_USER_MESSAGE_ID]?.message?.content.parts).toEqual(['Synthetic user prompt.']);
        expect(JSON.stringify(parsed?.raw_payload)).toBe(JSON.stringify(raw));
    });

    it('should merge detail metadata with full batch messages and preserve both canonical responses', () => {
        const detail = structuredClone(zaiDetailPayloadFixture);
        const batch = structuredClone(zaiMessagesBatchPayloadFixture);
        const parsed = mergeZaiConversationPayloads(detail, batch, ZAI_CONVERSATION_ID);

        expect(parsed).toMatchObject({
            title: 'Synthetic Z.ai Conversation',
            conversation_id: ZAI_CONVERSATION_ID,
            current_node: ZAI_ASSISTANT_MESSAGE_ID,
            create_time: 1_700_000_000,
            update_time: 1_700_000_003,
            default_model_slug: 'glm-synthetic',
        });
        expect(JSON.stringify(parsed?.raw_payload)).toBe(JSON.stringify({ detail, messages_batch: batch }));
    });

    it('should reject cross-conversation and malformed message graphs', () => {
        const mismatched = structuredClone(zaiMessagesBatchPayloadFixture);
        mismatched.chat_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        expect(mergeZaiConversationPayloads(zaiDetailPayloadFixture, mismatched)).toBeNull();

        const malformed = structuredClone(zaiMessagesBatchPayloadFixture);
        malformed.data[ZAI_ASSISTANT_MESSAGE_ID].id = ZAI_USER_MESSAGE_ID;
        expect(parseZaiMessagesBatch(malformed, ZAI_CONVERSATION_ID)).toBeNull();

        const missingCurrentNode = structuredClone(zaiDetailPayloadFixture);
        missingCurrentNode.chat.history.currentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        expect(parseZaiConversationDetail(missingCurrentNode, ZAI_CONVERSATION_ID)).toBeNull();
    });

    it('should reject invalid JSON and non-object payloads', () => {
        expect(parseZaiConversationDetail('{', ZAI_CONVERSATION_ID)).toBeNull();
        expect(parseZaiMessagesBatch([], ZAI_CONVERSATION_ID)).toBeNull();
    });
});
