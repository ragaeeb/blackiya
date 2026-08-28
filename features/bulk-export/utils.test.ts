import { describe, expect, it } from 'bun:test';
import {
    asRecord,
    ensureUniqueFilename,
    firstNonNull,
    parseJsonSafe,
    readNestedString,
    readString,
    resolveHostFromLocation,
    uniqueStrings,
    uniqueUrls,
} from './utils';

describe('uniqueStrings', () => {
    it('should deduplicate strings', () => {
        expect(uniqueStrings(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
    });

    it('should trim and deduplicate', () => {
        expect(uniqueStrings(['  a  ', 'a', ' a'])).toEqual(['a']);
    });

    it('should filter empty strings', () => {
        expect(uniqueStrings(['a', '', '   ', 'b'])).toEqual(['a', 'b']);
    });

    it('should skip non-string values', () => {
        expect(uniqueStrings(['a', 123 as any, 'b', null as any, 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('should return empty array for empty input', () => {
        expect(uniqueStrings([])).toEqual([]);
    });
});

describe('uniqueUrls', () => {
    it('should deduplicate URLs', () => {
        expect(uniqueUrls(['https://a.com', 'https://b.com', 'https://a.com'])).toEqual([
            'https://a.com',
            'https://b.com',
        ]);
    });

    it('should trim URLs', () => {
        expect(uniqueUrls(['  https://a.com  ', 'https://a.com'])).toEqual(['https://a.com']);
    });

    it('should filter empty URLs', () => {
        expect(uniqueUrls(['https://a.com', '', '   '])).toEqual(['https://a.com']);
    });

    it('should skip non-string values', () => {
        expect(uniqueUrls(['https://a.com', 123 as any, null as any])).toEqual(['https://a.com']);
    });
});

describe('parseJsonSafe', () => {
    it('should parse valid JSON', () => {
        expect(parseJsonSafe('{"key": "value"}')).toEqual({ key: 'value' });
    });

    it('should return null for invalid JSON', () => {
        expect(parseJsonSafe('not json')).toBeNull();
    });

    it('should return null for empty string', () => {
        expect(parseJsonSafe('')).toBeNull();
    });

    it('should parse JSON arrays', () => {
        expect(parseJsonSafe('[1, 2, 3]')).toEqual([1, 2, 3]);
    });
});

describe('asRecord', () => {
    it('should return record for plain object', () => {
        const obj = { key: 'value' };
        expect(asRecord(obj)).toBe(obj);
    });

    it('should return null for array', () => {
        expect(asRecord([1, 2, 3])).toBeNull();
    });

    it('should return null for null', () => {
        expect(asRecord(null)).toBeNull();
    });

    it('should return null for primitives', () => {
        expect(asRecord(42)).toBeNull();
        expect(asRecord('string')).toBeNull();
        expect(asRecord(undefined)).toBeNull();
    });
});

describe('readString', () => {
    it('should read string value', () => {
        expect(readString({ key: 'value' }, 'key')).toBe('value');
    });

    it('should return null for non-string value', () => {
        expect(readString({ key: 123 }, 'key')).toBeNull();
    });

    it('should return null for missing key', () => {
        expect(readString({ other: 'value' }, 'key')).toBeNull();
    });

    it('should return null for null record', () => {
        expect(readString(null, 'key')).toBeNull();
    });
});

describe('readNestedString', () => {
    it('should read nested string value', () => {
        const record = { container: { key: 'value' } };
        expect(readNestedString(record, 'container', 'key')).toBe('value');
    });

    it('should return null for non-nested value', () => {
        const record = { container: 'not an object' };
        expect(readNestedString(record, 'container', 'key')).toBeNull();
    });

    it('should return null for missing container', () => {
        expect(readNestedString({}, 'container', 'key')).toBeNull();
    });

    it('should return null for missing nested key', () => {
        const record = { container: { other: 'value' } };
        expect(readNestedString(record, 'container', 'key')).toBeNull();
    });
});

describe('firstNonNull', () => {
    it('should return first non-null value', () => {
        expect(firstNonNull([null, null, 'value', 'other'])).toBe('value');
    });

    it('should return null if all values are null', () => {
        expect(firstNonNull([null, null, null])).toBeNull();
    });

    it('should return null for empty array', () => {
        expect(firstNonNull([])).toBeNull();
    });

    it('should return first value if not null', () => {
        expect(firstNonNull(['first', 'second'])).toBe('first');
    });
});

describe('resolveHostFromLocation', () => {
    it('should extract hostname from valid URL', () => {
        expect(resolveHostFromLocation('https://example.com/path', 'fallback.com')).toBe('example.com');
    });

    it('should return fallback for invalid URL', () => {
        expect(resolveHostFromLocation('not a url', 'fallback.com')).toBe('fallback.com');
    });

    it('should return fallback for empty hostname', () => {
        expect(resolveHostFromLocation('file:///', 'fallback.com')).toBe('fallback.com');
    });

    it('should handle URLs with port', () => {
        expect(resolveHostFromLocation('https://example.com:8080/path', 'fallback.com')).toBe('example.com');
    });
});

describe('ensureUniqueFilename', () => {
    it('should return filename if not in use', () => {
        const used = new Set<string>();
        expect(ensureUniqueFilename('test', used)).toBe('test');
        expect(used.has('test')).toBe(true);
    });

    it('should append suffix for duplicate', () => {
        const used = new Set<string>(['test']);
        expect(ensureUniqueFilename('test', used)).toBe('test_2');
        expect(used.has('test_2')).toBe(true);
    });

    it('should increment suffix for multiple duplicates', () => {
        const used = new Set<string>(['test', 'test_2', 'test_3']);
        expect(ensureUniqueFilename('test', used)).toBe('test_4');
    });

    it('should trim filename', () => {
        const used = new Set<string>();
        expect(ensureUniqueFilename('  test  ', used)).toBe('test');
    });

    it('should use default for empty filename', () => {
        const used = new Set<string>();
        expect(ensureUniqueFilename('', used)).toBe('conversation_export');
    });

    it('should handle empty filename with duplicates', () => {
        const used = new Set<string>(['conversation_export']);
        expect(ensureUniqueFilename('', used)).toBe('conversation_export_2');
    });
});
