import type { V3BulkExportOptions } from '@/features/runtime/v3-runtime';

export const DEFAULT_DELAY_MS = 1_200;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const MIN_DELAY_MS = 250;
export const MAX_DELAY_MS = 20_000;
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 60_000;

export type NormalizedOptions = {
    maxItems: number | null;
    delayMs: number;
    timeoutMs: number;
};

const normalizePositiveInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
    if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(value)));
};

const normalizeMaxItems = (value: number | undefined): number | null => {
    if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
        return 100;
    }
    if (value <= 0) {
        return null;
    }
    return Math.floor(value);
};

export const normalizeOptions = (message: Partial<V3BulkExportOptions>): NormalizedOptions => ({
    maxItems: normalizeMaxItems(message.limit),
    delayMs: normalizePositiveInt(message.delayMs, DEFAULT_DELAY_MS, MIN_DELAY_MS, MAX_DELAY_MS),
    timeoutMs: normalizePositiveInt(message.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
});
