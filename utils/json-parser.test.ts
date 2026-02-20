import { describe, expect, it } from 'bun:test';
import { extractBalancedJsonArray } from '@/utils/json-parser';

describe('json-parser', () => {
    describe('extractBalancedJsonArray', () => {
        it('should return null if no starting bracket', () => {
            expect(extractBalancedJsonArray('somedata {}')).toBeNull();
        });

        it('should parse top level balanced array', () => {
            expect(extractBalancedJsonArray('[1, 2, 3]')).toBe('[1, 2, 3]');
        });

        it('should parse nested balanced array', () => {
            expect(extractBalancedJsonArray('[1, [2, 3], 4]')).toBe('[1, [2, 3], 4]');
        });

        it('should handle brackets within strings', () => {
            expect(extractBalancedJsonArray('["[not array]"]')).toBe('["[not array]"]');
        });

        it('should handle escaped quotes within strings', () => {
            expect(extractBalancedJsonArray('["inner \\"quote\\" "]')).toBe('["inner \\"quote\\" "]');
        });

        it('should return nested array if startFrom specifies inner index', () => {
            expect(extractBalancedJsonArray('outer [1, [2], 3] garbage', 10)).toBe('[2]');
        });

        it('should return null if array does not close properly', () => {
            expect(extractBalancedJsonArray('[1, 2')).toBeNull();
            expect(extractBalancedJsonArray('["unterminated string')).toBeNull();
        });
    });
});
