import { describe, expect, it } from 'bun:test';
import { extractGeminiConversationIdsFromBatchexecuteText } from './parsers-gemini';

describe('extractGeminiConversationIdsFromBatchexecuteText', () => {
    it('should extract conversation IDs with c_ prefix', () => {
        const text = 'some data c_abc123def c_xyz789ghi more data';
        expect(extractGeminiConversationIdsFromBatchexecuteText(text)).toEqual(['abc123def', 'xyz789ghi']);
    });

    it('should extract IDs with underscores and dashes', () => {
        const text = 'c_test_id-123 c_another-id_456';
        expect(extractGeminiConversationIdsFromBatchexecuteText(text)).toEqual(['test_id-123', 'another-id_456']);
    });

    it('should deduplicate IDs', () => {
        const text = 'c_abc123 c_xyz789 c_abc123';
        expect(extractGeminiConversationIdsFromBatchexecuteText(text)).toEqual(['abc123', 'xyz789']);
    });

    it('should filter short IDs', () => {
        const text = 'c_short c_valid_id_12345';
        expect(extractGeminiConversationIdsFromBatchexecuteText(text)).toEqual(['valid_id_12345']);
    });

    it('should require word boundary', () => {
        const text = 'notc_invalid c_valid123';
        expect(extractGeminiConversationIdsFromBatchexecuteText(text)).toEqual(['valid123']);
    });

    it('should return empty array for text with no IDs', () => {
        expect(extractGeminiConversationIdsFromBatchexecuteText('no ids here')).toEqual([]);
        expect(extractGeminiConversationIdsFromBatchexecuteText('')).toEqual([]);
    });

    it('should handle mixed case IDs', () => {
        const text = 'c_AbC123DeF c_XyZ789';
        expect(extractGeminiConversationIdsFromBatchexecuteText(text)).toEqual(['AbC123DeF', 'XyZ789']);
    });

    it('should extract from batchexecute-like response format', () => {
        const text = `)]}'

[["wrb.fr","someRpc","[\\"c_test123\\"]","generic"]]`;
        const result = extractGeminiConversationIdsFromBatchexecuteText(text);
        expect(result).toContain('test123');
    });
});
