import { describe, expect, it } from 'bun:test';
import {
    asTabId,
    clampBatchSize,
    DEFAULT_BATCH_SIZE,
    MAX_BATCH_SIZE,
} from '@/utils/external-api/background-hub-helpers';

describe('external-api/background-hub-helpers', () => {
    it('should clamp invalid values using a normalized fallback under max batch size', () => {
        expect(clampBatchSize(undefined, MAX_BATCH_SIZE + 500)).toBe(MAX_BATCH_SIZE);
        expect(clampBatchSize(Number.NaN, DEFAULT_BATCH_SIZE + 10)).toBe(DEFAULT_BATCH_SIZE + 10);
        expect(clampBatchSize(-1, 0)).toBe(DEFAULT_BATCH_SIZE);
    });

    it('should clamp explicit values to allowed range', () => {
        expect(clampBatchSize(1, DEFAULT_BATCH_SIZE)).toBe(1);
        expect(clampBatchSize(MAX_BATCH_SIZE + 1, DEFAULT_BATCH_SIZE)).toBe(MAX_BATCH_SIZE);
        expect(clampBatchSize(42.9, DEFAULT_BATCH_SIZE)).toBe(42);
    });

    it('should only accept finite non-negative integer tab ids', () => {
        expect(asTabId(0)).toBe(0);
        expect(asTabId(123)).toBe(123);
        expect(asTabId(-1)).toBeUndefined();
        expect(asTabId(1.5)).toBeUndefined();
        expect(asTabId(Number.NaN)).toBeUndefined();
        expect(asTabId(Number.POSITIVE_INFINITY)).toBeUndefined();
    });
});
