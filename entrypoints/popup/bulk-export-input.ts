import { DEFAULT_BULK_EXPORT_LIMIT } from '@/utils/settings';

const toFiniteNumber = (value: unknown): number | null => {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const normalized = trimmed.replace(/[,_\s]/g, '');
    if (!/^[-+]?\d+(\.\d+)?$/.test(normalized)) {
        return null;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
};

export const normalizeBulkExportNumberInput = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = toFiniteNumber(value);
    if (parsed === null) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(parsed)));
};

export const normalizeBulkExportLimitInput = (value: unknown): number => {
    const parsed = toFiniteNumber(value);
    if (parsed === null) {
        return DEFAULT_BULK_EXPORT_LIMIT;
    }
    if (parsed <= 0) {
        return 0;
    }
    return Math.floor(parsed);
};
