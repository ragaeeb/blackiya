import { describe, expect, it } from 'bun:test';
import { GOOGLE_SECURITY_PREFIX } from '../platforms/constants';
import { stripMagicHeader } from './text-utils';

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
});
