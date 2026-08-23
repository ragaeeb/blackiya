import { describe, expect, it } from 'bun:test';
import {
    ZAI_ASSISTANT_MESSAGE_ID,
    ZAI_CONVERSATION_ID,
    ZAI_USER_MESSAGE_ID,
    zaiDetailPayloadFixture,
} from './fixtures/har-derived';
import { buildZaiDetailRequest, buildZaiMessagesBatchRequest, extractZaiMessageIds } from './requests';

describe('Z.ai HAR-derived request builders', () => {
    it('should build the same-origin detail GET without persisting request context', () => {
        expect(buildZaiDetailRequest(ZAI_CONVERSATION_ID, { region: 'synthetic-region' })).toEqual({
            url: `https://chat.z.ai/api/v1/chats/${ZAI_CONVERSATION_ID}`,
            method: 'GET',
            headers: { 'x-region': 'synthetic-region' },
        });
    });

    it('should derive batch ids from the detail message graph', () => {
        expect(extractZaiMessageIds(zaiDetailPayloadFixture)).toEqual([ZAI_ASSISTANT_MESSAGE_ID, ZAI_USER_MESSAGE_ID]);
    });

    it('should build the message-batch POST with synthetic ids only', () => {
        const request = buildZaiMessagesBatchRequest(zaiDetailPayloadFixture, { region: 'synthetic-region' });

        expect(request).toMatchObject({
            url: `https://chat.z.ai/api/v1/chats/${ZAI_CONVERSATION_ID}/messages/batch`,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-region': 'synthetic-region',
            },
        });
        expect(JSON.parse(request!.body)).toEqual({
            ids: [ZAI_ASSISTANT_MESSAGE_ID, ZAI_USER_MESSAGE_ID],
        });
    });

    it('should omit absent optional context and reject malformed detail payloads', () => {
        expect(buildZaiDetailRequest(ZAI_CONVERSATION_ID)).toEqual({
            url: `https://chat.z.ai/api/v1/chats/${ZAI_CONVERSATION_ID}`,
            method: 'GET',
        });

        const malformed = structuredClone(zaiDetailPayloadFixture);
        malformed.chat.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        expect(buildZaiMessagesBatchRequest(malformed)).toBeNull();

        const missingCurrentNode = structuredClone(zaiDetailPayloadFixture);
        missingCurrentNode.chat.history.currentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        expect(buildZaiMessagesBatchRequest(missingCurrentNode)).toBeNull();
        expect(buildZaiDetailRequest('not-a-uuid')).toBeNull();
    });
});
