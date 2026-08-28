import { describe, expect, it } from 'bun:test';
import {
    DEFAULT_DELAY_MS,
    DEFAULT_TIMEOUT_MS,
    MAX_DELAY_MS,
    MAX_TIMEOUT_MS,
    MIN_DELAY_MS,
    MIN_TIMEOUT_MS,
    normalizeOptions,
} from './options';

describe('normalizeOptions', () => {
    it('should apply defaults when no options provided', () => {
        const result = normalizeOptions({});

        expect(result).toEqual({
            maxItems: 100,
            delayMs: DEFAULT_DELAY_MS,
            timeoutMs: DEFAULT_TIMEOUT_MS,
        });
    });

    it('should normalize valid limit to maxItems', () => {
        const result = normalizeOptions({
            limit: 50,
            delayMs: DEFAULT_DELAY_MS,
            timeoutMs: DEFAULT_TIMEOUT_MS,
        });

        expect(result.maxItems).toBe(50);
    });

    it('should treat limit 0 as null (unlimited)', () => {
        const result = normalizeOptions({
            limit: 0,
            delayMs: DEFAULT_DELAY_MS,
            timeoutMs: DEFAULT_TIMEOUT_MS,
        });

        expect(result.maxItems).toBeNull();
    });

    it('should treat negative limit as null (unlimited)', () => {
        const result = normalizeOptions({
            limit: -10,
            delayMs: DEFAULT_DELAY_MS,
            timeoutMs: DEFAULT_TIMEOUT_MS,
        });

        expect(result.maxItems).toBeNull();
    });

    it('should floor fractional limit', () => {
        const result = normalizeOptions({
            limit: 25.9,
            delayMs: DEFAULT_DELAY_MS,
            timeoutMs: DEFAULT_TIMEOUT_MS,
        });

        expect(result.maxItems).toBe(25);
    });

    it('should clamp delayMs to minimum', () => {
        const result = normalizeOptions({
            delayMs: 100,
            limit: 1,
            timeoutMs: DEFAULT_TIMEOUT_MS,
        });

        expect(result.delayMs).toBe(MIN_DELAY_MS);
    });

    it('should clamp delayMs to maximum', () => {
        const result = normalizeOptions({
            delayMs: 50_000,
            limit: 1,
            timeoutMs: DEFAULT_TIMEOUT_MS,
        });

        expect(result.delayMs).toBe(MAX_DELAY_MS);
    });

    it('should floor fractional delayMs', () => {
        const result = normalizeOptions({
            delayMs: 1500.7,
            limit: 1,
            timeoutMs: DEFAULT_TIMEOUT_MS,
        });

        expect(result.delayMs).toBe(1500);
    });

    it('should clamp timeoutMs to minimum', () => {
        const result = normalizeOptions({
            timeoutMs: 1_000,
            limit: 1,
            delayMs: DEFAULT_DELAY_MS,
        });

        expect(result.timeoutMs).toBe(MIN_TIMEOUT_MS);
    });

    it('should clamp timeoutMs to maximum', () => {
        const result = normalizeOptions({
            timeoutMs: 100_000,
            limit: 1,
            delayMs: DEFAULT_DELAY_MS,
        });

        expect(result.timeoutMs).toBe(MAX_TIMEOUT_MS);
    });

    it('should handle NaN values with defaults', () => {
        const result = normalizeOptions({
            limit: Number.NaN,
            delayMs: Number.NaN,
            timeoutMs: Number.NaN,
        });

        expect(result).toEqual({
            maxItems: 100,
            delayMs: DEFAULT_DELAY_MS,
            timeoutMs: DEFAULT_TIMEOUT_MS,
        });
    });

    it('should handle infinite values with defaults', () => {
        const result = normalizeOptions({
            limit: Number.POSITIVE_INFINITY,
            delayMs: Number.NEGATIVE_INFINITY,
            timeoutMs: Number.POSITIVE_INFINITY,
        });

        expect(result).toEqual({
            maxItems: 100,
            delayMs: DEFAULT_DELAY_MS,
            timeoutMs: DEFAULT_TIMEOUT_MS,
        });
    });

    it('should accept all valid custom options', () => {
        const result = normalizeOptions({
            limit: 25,
            delayMs: 800,
            timeoutMs: 15_000,
        });

        expect(result).toEqual({
            maxItems: 25,
            delayMs: 800,
            timeoutMs: 15_000,
        });
    });
});
