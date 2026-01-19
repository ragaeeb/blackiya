import { describe, expect, it } from 'bun:test';
import { geminiAdapter } from './gemini';

describe('geminiAdapter', () => {
    it('should identify Gemini URLs', () => {
        expect(geminiAdapter.isPlatformUrl('https://gemini.google.com/app')).toBe(true);
        expect(geminiAdapter.isPlatformUrl('https://chatgpt.com')).toBe(false);
    });

    it('should extract conversation ID from Gemini URLs', () => {
        expect(geminiAdapter.extractConversationId('https://gemini.google.com/app/123abc456')).toBe('123abc456');
        expect(geminiAdapter.extractConversationId('https://gemini.google.com/share/shared-id')).toBe('shared-id');
    });

    it('should parse batchexecute response', () => {
        // Structure:
        // 1. Magic header
        // 2. Length (ignored by parser if we strip header/newlines carefully)
        // 3. Outer JSON: [["wrb.fr", "hNvQHb", "innerJSON", ...]]
        // 4. Inner JSON (payload): [[["conversationId", "responseId", [messages...]]]]

        const innerPayload = JSON.stringify([
            [[['c_test-id', 'r_response-id', [['message 1 data'], ['message 2 data']]]]],
        ]);

        const mockResponse = `)]}'\n\n123\n[["wrb.fr","hNvQHb","${innerPayload.replace(/"/g, '\\"')}"]]`;

        // Mock window.location.href for the adapter
        globalThis.window = { location: { href: 'https://gemini.google.com/app/test-id' } } as any;

        const result = geminiAdapter.parseInterceptedData(
            mockResponse,
            'https://gemini.google.com/_/BardChatUi/data/batchexecute',
        );

        expect(result).not.toBeNull();
        expect(result?.conversation_id).toBe('test-id'); // Parser extracts from payload and normalizes
        expect(Object.keys(result?.mapping || {}).length).toBe(2);
    });

    it('should return null for non-matching RPC IDs', () => {
        const mockResponse = `)]}'

123
[["wrb.fr","wrongId","[[[\\"rc_id\\",[\\"Message 1\\"]]]]"]]`;

        const result = geminiAdapter.parseInterceptedData(mockResponse, 'url');
        expect(result).toBeNull();
    });
});
