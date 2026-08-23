import { describe, expect, it } from 'bun:test';
import { QWEN_FIXTURE_CONVERSATION_ID } from './fixtures/conversation-detail';
import { qwenAdapter } from './index';

describe('qwenAdapter', () => {
    it('should recognize only chat.qwen.ai URLs', () => {
        expect(qwenAdapter.isPlatformUrl('https://chat.qwen.ai/')).toBeTrue();
        expect(qwenAdapter.isPlatformUrl(`https://chat.qwen.ai/c/${QWEN_FIXTURE_CONVERSATION_ID}`)).toBeTrue();
        expect(qwenAdapter.isPlatformUrl('https://chat.qwen.ai.evil.example/c/fake')).toBeFalse();
        expect(qwenAdapter.isPlatformUrl('http://chat.qwen.ai/')).toBeFalse();
        expect(qwenAdapter.isPlatformUrl('not a url')).toBeFalse();
    });

    it('should extract a UUID conversation ID from /c/{id} URLs', () => {
        expect(
            qwenAdapter.extractConversationId(
                `https://chat.qwen.ai/c/${QWEN_FIXTURE_CONVERSATION_ID}?fixture=true#synthetic`,
            ),
        ).toBe(QWEN_FIXTURE_CONVERSATION_ID);
        expect(
            qwenAdapter.extractConversationId(`https://chat.qwen.ai/api/v2/chats/${QWEN_FIXTURE_CONVERSATION_ID}`),
        ).toBeNull();
        expect(qwenAdapter.extractConversationId('https://chat.qwen.ai/c/not-a-uuid')).toBeNull();
        expect(qwenAdapter.extractConversationId(`https://example.com/c/${QWEN_FIXTURE_CONVERSATION_ID}`)).toBeNull();
    });

    it('should expose the HAR-derived detail URL through the platform contract', () => {
        const expected = `https://chat.qwen.ai/api/v2/chats/${QWEN_FIXTURE_CONVERSATION_ID}?direction=up&limit=10`;

        expect(qwenAdapter.buildApiUrl?.(QWEN_FIXTURE_CONVERSATION_ID)).toBe(expected);
        expect(qwenAdapter.buildApiUrls?.(QWEN_FIXTURE_CONVERSATION_ID)).toEqual([expected]);
        expect(qwenAdapter.buildApiUrls?.('not-a-uuid')).toEqual([]);
    });

    it('should narrowly classify only HAR-derived page-owned conversation detail requests', () => {
        const detailUrl = `https://chat.qwen.ai/api/v2/chats/${QWEN_FIXTURE_CONVERSATION_ID}`;
        const pagedDetailUrl = `${detailUrl}?direction=up&limit=10`;

        expect(qwenAdapter.isConversationDetailRequest?.(detailUrl, 'GET')).toBeFalse();
        expect(qwenAdapter.isConversationDetailRequest?.(pagedDetailUrl, 'get')).toBeTrue();
        expect(qwenAdapter.isConversationDetailRequest?.(detailUrl, 'POST')).toBeFalse();
        expect(qwenAdapter.isConversationDetailRequest?.('https://chat.qwen.ai/api/v2/chats/', 'GET')).toBeFalse();
        expect(
            qwenAdapter.isConversationDetailRequest?.('https://chat.qwen.ai/api/v2/chats/pinned', 'GET'),
        ).toBeFalse();
        expect(qwenAdapter.isConversationDetailRequest?.(`${detailUrl}/tags`, 'GET')).toBeFalse();
        expect(qwenAdapter.isConversationDetailRequest?.(`${detailUrl}?direction=down&limit=10`, 'GET')).toBeFalse();
        expect(qwenAdapter.isConversationDetailRequest?.(`${pagedDetailUrl}&extra=true`, 'GET')).toBeFalse();
        expect(qwenAdapter.isConversationDetailRequest?.(`${pagedDetailUrl}&direction=up`, 'GET')).toBeFalse();
        expect(qwenAdapter.isConversationDetailRequest?.(`${pagedDetailUrl}&limit=10`, 'GET')).toBeFalse();
        expect(
            qwenAdapter.isConversationDetailRequest?.(
                `https://example.com/api/v2/chats/${QWEN_FIXTURE_CONVERSATION_ID}`,
                'GET',
            ),
        ).toBeFalse();
    });
});
