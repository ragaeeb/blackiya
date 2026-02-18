import { describe, expect, it } from 'bun:test';
import { GOOGLE_SECURITY_PREFIX } from '../platforms/constants';
import { dedupePreserveOrder, keepMostRecentEntries, stripMagicHeader } from './text-utils';

describe('Text Utils', () => {
    describe('stripMagicHeader', () => {
        it('should strip exact magic header', () => {
            const input = `${GOOGLE_SECURITY_PREFIX}{"a":1}`;
            expect(stripMagicHeader(input)).toBe('{"a":1}');
        });

        it('should strip magic header with variable whitespace', () => {
            const input = ')]}\'   \n\n{"a":1}';
            expect(stripMagicHeader(input)).toBe('{"a":1}');
        });

        it('should return original text if header is missing', () => {
            const input = '{"a":1}';
            expect(stripMagicHeader(input)).toBe('{"a":1}');
        });

        it('should handle empty strings', () => {
            expect(stripMagicHeader('')).toBe('');
        });

        it('should trim start of string before checking', () => {
            const input = '   )]}\'\n\n{"a":1}';
            expect(stripMagicHeader(input)).toBe('{"a":1}');
        });
    });

    describe('dedupePreserveOrder', () => {
        it('removes duplicate entries while preserving first-seen order', () => {
            expect(dedupePreserveOrder(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
        });
    });

    describe('keepMostRecentEntries', () => {
        it('keeps only the tail entries up to max size', () => {
            expect(keepMostRecentEntries(['a', 'b', 'c', 'd'], 2)).toEqual(['c', 'd']);
        });

        it('returns copy unchanged when list is within max size', () => {
            const values = ['a', 'b'];
            const trimmed = keepMostRecentEntries(values, 4);
            expect(trimmed).toEqual(values);
            expect(trimmed).not.toBe(values);
        });
    });
});
