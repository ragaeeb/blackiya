/**
 * Tests for Download Utilities
 *
 * TDD tests for filename sanitization and timestamp generation
 */

import { describe, expect, it } from 'bun:test';
import { downloadAsJSON, generateTimestamp, sanitizeFilename } from '@/utils/download';

type MockAnchor = {
    href: string;
    download: string;
    click: () => void;
    parentNode: {
        removeChild: (node: unknown) => void;
    } | null;
};

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
        it('should not throw when JSON serialization fails', () => {
            const circular: Record<string, unknown> = {};
            circular.self = circular;

            const appended: unknown[] = [];
            const removed: unknown[] = [];
            const link: MockAnchor = {
                href: '',
                download: '',
                click: () => {},
                parentNode: null,
            };
            const browserApis = {
                document: {
                    body: {
                        appendChild: (node: unknown) => {
                            appended.push(node);
                        },
                        removeChild: (node: unknown) => {
                            removed.push(node);
                        },
                    },
                    createElement: () => link,
                },
                URL: {
                    createObjectURL: () => 'blob:mock',
                    revokeObjectURL: () => {},
                },
            };

            expect(() => downloadAsJSON(circular, 'test', browserApis)).not.toThrow();
            expect(appended).toEqual([]);
            expect(removed).toEqual([]);
        });

        it('should remove link and revoke URL on successful download', () => {
            const appended: unknown[] = [];
            const removed: unknown[] = [];
            const revokedUrls: string[] = [];
            let clicked = false;

            const body = {
                appendChild: (node: unknown) => {
                    const anchor = node as MockAnchor;
                    anchor.parentNode = body;
                    appended.push(node);
                },
                removeChild: (node: unknown) => {
                    removed.push(node);
                },
            };

            const link: MockAnchor = {
                href: '',
                download: '',
                parentNode: null,
                click: () => {
                    clicked = true;
                },
            };

            const browserApis = {
                document: {
                    body,
                    createElement: () => link,
                },
                URL: {
                    createObjectURL: () => 'blob:success',
                    revokeObjectURL: (url: string) => {
                        revokedUrls.push(url);
                    },
                },
            };

            expect(() => downloadAsJSON({ ok: true }, 'test', browserApis)).not.toThrow();
            expect(clicked).toBe(true);
            expect(link.download).toBe('test.json');
            expect(link.href).toBe('blob:success');
            expect(appended).toEqual([link]);
            expect(removed).toEqual([link]);
            expect(revokedUrls).toEqual(['blob:success']);
        });

        it('should not throw when createObjectURL fails', () => {
            const appended: unknown[] = [];
            const removed: unknown[] = [];
            const link: MockAnchor = {
                href: '',
                download: '',
                click: () => {},
                parentNode: null,
            };

            const browserApis = {
                document: {
                    body: {
                        appendChild: (node: unknown) => {
                            appended.push(node);
                        },
                        removeChild: (node: unknown) => {
                            removed.push(node);
                        },
                    },
                    createElement: () => link,
                },
                URL: {
                    createObjectURL: () => {
                        throw new Error('blob-failure');
                    },
                    revokeObjectURL: () => {},
                },
            };

            expect(() => downloadAsJSON({ ok: true }, 'test', browserApis)).not.toThrow();
            expect(appended).toEqual([]);
            expect(removed).toEqual([]);
        });
    });
});
