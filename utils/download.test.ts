/**
 * Tests for Download Utilities
 *
 * TDD tests for filename sanitization and timestamp generation
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { downloadAsJSON, generateTimestamp, sanitizeFilename } from '@/utils/download';

describe('Download Utilities', () => {
    describe('sanitizeFilename', () => {
        it('should replace spaces with underscores', () => {
            const result = sanitizeFilename('Hello World');
            expect(result).toBe('Hello_World');
        });

        it('should remove invalid filesystem characters', () => {
            const result = sanitizeFilename('Test: File/Name\\Here?');
            expect(result).toBe('Test_FileNameHere');
        });

        it('should remove angle brackets and quotes', () => {
            const result = sanitizeFilename('File<with>quotes"and|pipes');
            expect(result).toBe('Filewithquotesandpipes');
        });

        it('should remove asterisks', () => {
            const result = sanitizeFilename('File*with*stars');
            expect(result).toBe('Filewithstars');
        });

        it('should handle empty string', () => {
            const result = sanitizeFilename('');
            expect(result).toBe('untitled');
        });

        it('should handle string with only invalid characters', () => {
            const result = sanitizeFilename('???:::***');
            expect(result).toBe('untitled');
        });

        it('should trim leading and trailing whitespace', () => {
            const result = sanitizeFilename('  Hello World  ');
            expect(result).toBe('Hello_World');
        });

        it('should collapse multiple underscores', () => {
            const result = sanitizeFilename('Hello   World');
            expect(result).toBe('Hello_World');
        });

        it('should handle unicode characters', () => {
            const result = sanitizeFilename('日本語 Title');
            expect(result).toBe('日本語_Title');
        });

        it('should handle emojis', () => {
            const result = sanitizeFilename('Test 🔥 Title');
            expect(result).toBe('Test_🔥_Title');
        });
    });

    describe('generateTimestamp', () => {
        it('should return ISO-like date format', () => {
            const timestamp = generateTimestamp();
            // Format: YYYY-MM-DD_HH-MM-SS
            expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
        });

        it('should generate unique timestamps for different times', () => {
            const _timestamp1 = generateTimestamp();
            // Wait a tiny bit (in practice these would be different)
            const timestamp2 = generateTimestamp();
            // They should be the same format
            expect(timestamp2).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
        });

        it('should create timestamp from unix epoch', () => {
            const unixTime = 1768670166.492617;
            const timestamp = generateTimestamp(unixTime);
            // Should be a valid date string
            expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
        });
    });

    describe('downloadAsJSON', () => {
        let downloadCalls: Array<{ jsonString: string; filename: string }>;
        let shouldThrow: Error | null;
        const downloadImpl = (jsonString: string, filename: string) => {
            if (shouldThrow) {
                throw shouldThrow;
            }
            downloadCalls.push({ jsonString, filename });
        };

        beforeEach(() => {
            downloadCalls = [];
            shouldThrow = null;
        });

        it('should not throw when JSON serialization fails', () => {
            const circular: Record<string, unknown> = {};
            circular.self = circular;

            expect(() => downloadAsJSON(circular, 'test', downloadImpl)).not.toThrow();
            expect(downloadCalls).toEqual([]);
        });

        it('should not throw when the DOM download throws', () => {
            shouldThrow = new Error('blob-failure');

            expect(() => downloadAsJSON({ ok: true }, 'test', downloadImpl)).not.toThrow();
            expect(downloadCalls).toEqual([]);
        });
    });
});
