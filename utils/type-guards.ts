export const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

export const hasString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

export const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
