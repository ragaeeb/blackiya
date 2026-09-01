import { describe, expect, it } from 'bun:test';

import { chatGPTAdapter } from './index';

describe('ChatGPT adapter URL matching', () => {
    it('should match only exact HTTPS ChatGPT provider hostnames', () => {
        expect(chatGPTAdapter.isPlatformUrl('https://chatgpt.com/c/synthetic')).toBeTrue();
        expect(chatGPTAdapter.isPlatformUrl('https://chat.openai.com/c/synthetic')).toBeTrue();
        expect(chatGPTAdapter.isPlatformUrl('http://chatgpt.com/c/synthetic')).toBeFalse();
        expect(chatGPTAdapter.isPlatformUrl('https://chatgpt.com.evil.invalid/c/synthetic')).toBeFalse();
        expect(chatGPTAdapter.isPlatformUrl('https://claude.ai/chat/synthetic?source=chatgpt.com')).toBeFalse();
        expect(chatGPTAdapter.isPlatformUrl('not-a-url')).toBeFalse();
    });

    it('should recognize singular and plural conversation detail routes', () => {
        const conversationId = '6a942762-a600-83e9-aa02-7de4e6983295';

        expect(
            chatGPTAdapter.isConversationDetailRequest?.(
                `https://chatgpt.com/backend-api/conversations/${conversationId}?include_has_versions=true&num_turns=100`,
                'GET',
            ),
        ).toBeTrue();
        expect(
            chatGPTAdapter.isConversationDetailRequest?.(
                `https://chatgpt.com/backend-api/conversation/${conversationId}`,
                'GET',
            ),
        ).toBeTrue();
        expect(
            chatGPTAdapter.isConversationDetailRequest?.('https://chatgpt.com/backend-api/conversations', 'GET'),
        ).toBeFalse();
    });
});
