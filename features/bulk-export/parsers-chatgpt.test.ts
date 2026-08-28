import { describe, expect, it } from 'bun:test';
import { extractChatGptConversationIdsFromPayload, extractChatGptConversationIdsFromText } from './parsers-chatgpt';

describe('extractChatGptConversationIdsFromPayload', () => {
    it('should extract IDs from items array', () => {
        const payload = {
            items: [{ id: 'abc-123-def' }, { id: 'def-789-abc' }],
        };
        expect(extractChatGptConversationIdsFromPayload(payload)).toEqual(['abc-123-def', 'def-789-abc']);
    });

    it('should extract IDs from conversations array', () => {
        const payload = {
            conversations: [{ conversation_id: 'abc-123' }, { conversation_id: 'def-789' }],
        };
        expect(extractChatGptConversationIdsFromPayload(payload)).toEqual(['abc-123', 'def-789']);
    });

    it('should extract IDs from nested conversation object', () => {
        const payload = {
            items: [{ conversation: { id: 'abc-def-123' } }],
        };
        expect(extractChatGptConversationIdsFromPayload(payload)).toEqual(['abc-def-123']);
    });

    it('should extract from data.items', () => {
        const payload = {
            data: {
                items: [{ id: 'dada-1234-efab' }],
            },
        };
        expect(extractChatGptConversationIdsFromPayload(payload)).toEqual(['dada-1234-efab']);
    });

    it('should extract from payload.conversations', () => {
        const payload = {
            payload: {
                conversations: [{ id: 'abcd-ef01-2345' }],
            },
        };
        expect(extractChatGptConversationIdsFromPayload(payload)).toEqual(['abcd-ef01-2345']);
    });

    it('should deduplicate IDs', () => {
        const payload = {
            items: [{ id: 'abc-12345' }, { id: 'abc-12345' }, { id: 'def-78901' }],
        };
        expect(extractChatGptConversationIdsFromPayload(payload)).toEqual(['abc-12345', 'def-78901']);
    });

    it('should filter invalid IDs', () => {
        const payload = {
            items: [{ id: 'abc-def-123' }, { id: 'short' }, { id: 'INVALID@!' }],
        };
        expect(extractChatGptConversationIdsFromPayload(payload)).toEqual(['abc-def-123']);
    });

    it('should return empty array for non-object payload', () => {
        expect(extractChatGptConversationIdsFromPayload(null)).toEqual([]);
        expect(extractChatGptConversationIdsFromPayload('string')).toEqual([]);
        expect(extractChatGptConversationIdsFromPayload(123)).toEqual([]);
    });

    it('should handle missing arrays', () => {
        const payload = { other: 'data' };
        expect(extractChatGptConversationIdsFromPayload(payload)).toEqual([]);
    });
});

describe('extractChatGptConversationIdsFromText', () => {
    it('should extract IDs from id field', () => {
        const text = '{"id": "abc-123-def", "other": "data"}';
        expect(extractChatGptConversationIdsFromText(text)).toEqual(['abc-123-def']);
    });

    it('should extract IDs from conversation_id field', () => {
        const text = '{"conversation_id": "def-789-abc"}';
        expect(extractChatGptConversationIdsFromText(text)).toEqual(['def-789-abc']);
    });

    it('should extract IDs from nested conversation.id', () => {
        const text = '{"conversation": {"id": "abc-def-123"}}';
        expect(extractChatGptConversationIdsFromText(text)).toEqual(['abc-def-123']);
    });

    it('should extract multiple IDs', () => {
        const text = '{"id": "abc-def-123", "other": {"conversation_id": "def-abc-456"}}';
        const result = extractChatGptConversationIdsFromText(text);
        expect(result).toContain('abc-def-123');
        expect(result).toContain('def-abc-456');
    });

    it('should handle whitespace variations', () => {
        const text = '{ "id"  :  "abc-12345"  , "conversation_id" :   "def-78901" }';
        const result = extractChatGptConversationIdsFromText(text);
        expect(result).toContain('abc-12345');
        expect(result).toContain('def-78901');
    });

    it('should deduplicate IDs', () => {
        const text = '{"id": "abc-12345", "conversation_id": "abc-12345"}';
        expect(extractChatGptConversationIdsFromText(text)).toEqual(['abc-12345']);
    });

    it('should filter short IDs', () => {
        const text = '{"id": "short", "conversation_id": "abc-def-123"}';
        expect(extractChatGptConversationIdsFromText(text)).toEqual(['abc-def-123']);
    });

    it('should return empty array for text with no IDs', () => {
        expect(extractChatGptConversationIdsFromText('no ids here')).toEqual([]);
        expect(extractChatGptConversationIdsFromText('')).toEqual([]);
    });

    it('should handle case insensitive matching', () => {
        const text = '{"id": "ABC-123-DEF"}';
        expect(extractChatGptConversationIdsFromText(text)).toEqual(['ABC-123-DEF']);
    });
});
