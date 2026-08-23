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
});
