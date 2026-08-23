import { describe, expect, it } from 'bun:test';
import { ZAI_CONVERSATION_ID, zaiDetailPayloadFixture, zaiMessagesBatchPayloadFixture } from './fixtures/har-derived';
import { zaiAdapter } from './index';

describe('Z.ai adapter', () => {
    it('should recognize only chat.z.ai URLs', () => {
        expect(zaiAdapter.isPlatformUrl(`https://chat.z.ai/c/${ZAI_CONVERSATION_ID}`)).toBeTrue();
        expect(zaiAdapter.isPlatformUrl(`https://evilchat.z.ai/c/${ZAI_CONVERSATION_ID}`)).toBeFalse();
        expect(zaiAdapter.isPlatformUrl('not a URL')).toBeFalse();
    });

    it('should extract a conversation UUID from a conversation URL', () => {
        expect(zaiAdapter.extractConversationId(`https://chat.z.ai/c/${ZAI_CONVERSATION_ID}?synthetic=1`)).toBe(
            ZAI_CONVERSATION_ID,
        );
        expect(zaiAdapter.extractConversationId('https://chat.z.ai/')).toBeNull();
        expect(zaiAdapter.extractConversationId('https://chat.z.ai/c/not-a-uuid')).toBeNull();
    });

    it('should narrowly classify only the HAR-derived terminal batch response', () => {
        const batchUrl = `https://chat.z.ai/api/v1/chats/${ZAI_CONVERSATION_ID}/messages/batch`;

        expect(zaiAdapter.isConversationDetailRequest?.(batchUrl, 'POST')).toBeTrue();
        expect(zaiAdapter.isConversationDetailRequest?.(batchUrl, 'GET')).toBeFalse();
        expect(
            zaiAdapter.isConversationDetailRequest?.(`https://chat.z.ai/api/v1/chats/${ZAI_CONVERSATION_ID}`, 'POST'),
        ).toBeFalse();
        expect(zaiAdapter.isConversationDetailRequest?.(`${batchUrl}?synthetic=1`, 'POST')).toBeFalse();
        expect(
            zaiAdapter.isConversationDetailRequest?.(
                `https://not-chat.z.ai/api/v1/chats/${ZAI_CONVERSATION_ID}/messages/batch`,
                'POST',
            ),
        ).toBeFalse();
        expect(zaiAdapter.buildApiUrl).toBeUndefined();
        expect(zaiAdapter.buildApiUrls).toBeUndefined();
    });

    it('should parse both detail and message-batch response URLs', () => {
        const detail = zaiAdapter.parseInterceptedData(
            JSON.stringify(zaiDetailPayloadFixture),
            `https://chat.z.ai/api/v1/chats/${ZAI_CONVERSATION_ID}`,
        );
        const batch = zaiAdapter.parseInterceptedData(
            JSON.stringify(zaiMessagesBatchPayloadFixture),
            `https://chat.z.ai/api/v1/chats/${ZAI_CONVERSATION_ID}/messages/batch`,
        );

        expect(detail?.conversation_id).toBe(ZAI_CONVERSATION_ID);
        expect(batch?.conversation_id).toBe(ZAI_CONVERSATION_ID);
        expect(zaiAdapter.evaluateReadiness?.(detail!)).toMatchObject({ ready: false, terminal: false });
        expect(zaiAdapter.evaluateReadiness?.(batch!)).toMatchObject({ ready: true, terminal: true });
    });

    it('should fail closed for unrelated endpoints and payload-id mismatches', () => {
        expect(zaiAdapter.parseInterceptedData('{}', 'https://chat.z.ai/api/models')).toBeNull();
        expect(
            zaiAdapter.parseInterceptedData(
                JSON.stringify(zaiMessagesBatchPayloadFixture),
                'https://chat.z.ai/api/v1/chats/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/messages/batch',
            ),
        ).toBeNull();
    });

    it('should format a sanitized Z.ai filename', () => {
        const data = zaiAdapter.parseInterceptedData(
            JSON.stringify(zaiDetailPayloadFixture),
            `https://chat.z.ai/api/v1/chats/${ZAI_CONVERSATION_ID}`,
        );

        expect(zaiAdapter.formatFilename({ ...data!, title: 'Synthetic / Z.ai : Export' })).toStartWith(
            'Synthetic_Z.ai_Export_',
        );
    });
});
