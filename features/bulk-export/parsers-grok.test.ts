import { describe, expect, it } from 'bun:test';
import {
    extractGrokComConversationIdsFromPayload,
    extractGrokComConversationIdsFromText,
    extractGrokResponseIdsFromNodeText,
} from './parsers-grok';

describe('extractGrokComConversationIdsFromPayload', () => {
    it('should extract IDs from items array', () => {
        const payload = {
            items: [
                { id: '12345678-1234-1234-1234-123456789abc' },
                { id: 'abcdef12-3456-7890-abcd-ef1234567890' },
            ],
        };
        const result = extractGrokComConversationIdsFromPayload(payload);
        expect(result).toEqual([
            '12345678-1234-1234-1234-123456789abc',
            'abcdef12-3456-7890-abcd-ef1234567890',
        ]);
    });

    it('should extract from conversationId field', () => {
        const payload = {
            conversations: [{ conversationId: '12345678-1234-1234-1234-123456789abc' }],
        };
        expect(extractGrokComConversationIdsFromPayload(payload)).toEqual([
            '12345678-1234-1234-1234-123456789abc',
        ]);
    });

    it('should extract from nested conversation.id', () => {
        const payload = {
            items: [{ conversation: { id: '12345678-1234-1234-1234-123456789abc' } }],
        };
        expect(extractGrokComConversationIdsFromPayload(payload)).toEqual([
            '12345678-1234-1234-1234-123456789abc',
        ]);
    });

    it('should extract from grokConversation.rest_id', () => {
        const payload = {
            items: [{ grokConversation: { rest_id: '12345678-1234-1234-1234-123456789abc' } }],
        };
        expect(extractGrokComConversationIdsFromPayload(payload)).toEqual([
            '12345678-1234-1234-1234-123456789abc',
        ]);
    });

    it('should deduplicate IDs', () => {
        const payload = {
            items: [
                { id: '12345678-1234-1234-1234-123456789abc' },
                { id: '12345678-1234-1234-1234-123456789abc' },
            ],
        };
        expect(extractGrokComConversationIdsFromPayload(payload)).toEqual([
            '12345678-1234-1234-1234-123456789abc',
        ]);
    });

    it('should filter invalid UUIDs', () => {
        const payload = {
            items: [
                { id: '12345678-1234-1234-1234-123456789abc' },
                { id: 'not-a-uuid' },
                { id: '12345678-1234' },
            ],
        };
        expect(extractGrokComConversationIdsFromPayload(payload)).toEqual([
            '12345678-1234-1234-1234-123456789abc',
        ]);
    });

    it('should return empty array for non-object payload', () => {
        expect(extractGrokComConversationIdsFromPayload(null)).toEqual([]);
        expect(extractGrokComConversationIdsFromPayload('string')).toEqual([]);
    });
});

describe('extractGrokComConversationIdsFromText', () => {
    it('should extract from conversationId field', () => {
        const text = '{"conversationId": "12345678-1234-1234-1234-123456789abc"}';
        expect(extractGrokComConversationIdsFromText(text)).toEqual(['12345678-1234-1234-1234-123456789abc']);
    });

    it('should extract from conversation_id field', () => {
        const text = '{"conversation_id": "abcdef12-3456-7890-abcd-ef1234567890"}';
        expect(extractGrokComConversationIdsFromText(text)).toEqual(['abcdef12-3456-7890-abcd-ef1234567890']);
    });

    it('should extract from id field', () => {
        const text = '{"id": "12345678-1234-1234-1234-123456789abc"}';
        expect(extractGrokComConversationIdsFromText(text)).toEqual(['12345678-1234-1234-1234-123456789abc']);
    });

    it('should extract from nested conversation.id', () => {
        const text = '{"conversation": {"id": "12345678-1234-1234-1234-123456789abc"}}';
        expect(extractGrokComConversationIdsFromText(text)).toEqual(['12345678-1234-1234-1234-123456789abc']);
    });

    it('should deduplicate IDs', () => {
        const text =
            '{"id": "12345678-1234-1234-1234-123456789abc", "conversationId": "12345678-1234-1234-1234-123456789abc"}';
        expect(extractGrokComConversationIdsFromText(text)).toEqual(['12345678-1234-1234-1234-123456789abc']);
    });

    it('should filter invalid UUIDs', () => {
        const text = '{"id": "not-a-uuid", "conversationId": "12345678-1234-1234-1234-123456789abc"}';
        expect(extractGrokComConversationIdsFromText(text)).toEqual(['12345678-1234-1234-1234-123456789abc']);
    });

    it('should return empty array for text with no IDs', () => {
        expect(extractGrokComConversationIdsFromText('no ids here')).toEqual([]);
        expect(extractGrokComConversationIdsFromText('')).toEqual([]);
    });
});

describe('extractGrokResponseIdsFromNodeText', () => {
    it('should extract from responseNodes array', () => {
        const text = JSON.stringify({
            responseNodes: [
                { responseId: '12345678-1234-1234-1234-123456789abc' },
                { responseId: 'abcdef12-3456-7890-abcd-ef1234567890' },
            ],
        });
        const result = extractGrokResponseIdsFromNodeText(text);
        expect(result).toContain('12345678-1234-1234-1234-123456789abc');
        expect(result).toContain('abcdef12-3456-7890-abcd-ef1234567890');
    });

    it('should extract from inflightResponses array', () => {
        const text = JSON.stringify({
            inflightResponses: [{ responseId: '12345678-1234-1234-1234-123456789abc' }],
        });
        expect(extractGrokResponseIdsFromNodeText(text)).toEqual(['12345678-1234-1234-1234-123456789abc']);
    });

    it('should deduplicate IDs', () => {
        const text = JSON.stringify({
            responseNodes: [
                { responseId: '12345678-1234-1234-1234-123456789abc' },
                { responseId: '12345678-1234-1234-1234-123456789abc' },
            ],
        });
        expect(extractGrokResponseIdsFromNodeText(text)).toEqual(['12345678-1234-1234-1234-123456789abc']);
    });

    it('should fall back to regex extraction', () => {
        const text = '{"responseId": "12345678-1234-1234-1234-123456789abc", "other": "data"}';
        expect(extractGrokResponseIdsFromNodeText(text)).toEqual(['12345678-1234-1234-1234-123456789abc']);
    });

    it('should filter invalid UUIDs', () => {
        const text = JSON.stringify({
            responseNodes: [{ responseId: 'not-a-uuid' }, { responseId: '12345678-1234-1234-1234-123456789abc' }],
        });
        expect(extractGrokResponseIdsFromNodeText(text)).toEqual(['12345678-1234-1234-1234-123456789abc']);
    });

    it('should return empty array for text with no IDs', () => {
        expect(extractGrokResponseIdsFromNodeText('no ids here')).toEqual([]);
        expect(extractGrokResponseIdsFromNodeText('')).toEqual([]);
    });
});
