import { describe, expect, it } from 'bun:test';
import { normalizeBulkExportLimitInput, normalizeBulkExportNumberInput } from '@/entrypoints/popup/bulk-export-input';

describe('popup bulk export input normalization', () => {
    it('should normalize limit from numeric strings with separators', () => {
        expect(normalizeBulkExportLimitInput('2,000')).toBe(2000);
        expect(normalizeBulkExportLimitInput('2_000')).toBe(2000);
        expect(normalizeBulkExportLimitInput('2 000')).toBe(2000);
    });

    it('should normalize limit with 0 as all', () => {
        expect(normalizeBulkExportLimitInput('0')).toBe(0);
        expect(normalizeBulkExportLimitInput(-5)).toBe(0);
    });

    it('should clamp numeric options and use fallback on invalid inputs', () => {
        expect(normalizeBulkExportNumberInput('2,500', 100, 250, 20_000)).toBe(2500);
        expect(normalizeBulkExportNumberInput('abc', 1200, 250, 20_000)).toBe(1200);
        expect(normalizeBulkExportNumberInput('10', 1200, 250, 20_000)).toBe(250);
        expect(normalizeBulkExportNumberInput('999999', 1200, 250, 20_000)).toBe(20_000);
    });
});
