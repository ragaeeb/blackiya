export const uniqueStrings = (values: string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        if (typeof value !== 'string') {
            continue;
        }
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) {
            continue;
        }
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
};

export const uniqueUrls = (urls: string[]): string[] => {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const candidate of urls) {
        if (typeof candidate !== 'string') {
            continue;
        }
        const url = candidate.trim();
        if (!url || seen.has(url)) {
            continue;
        }
        seen.add(url);
        result.push(url);
    }
    return result;
};

export const parseJsonSafe = (text: string): unknown | null => {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

export const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const readString = (record: Record<string, unknown> | null, key: string): string | null => {
    if (!record) {
        return null;
    }
    const value = record[key];
    return typeof value === 'string' ? value : null;
};

export const readNestedString = (
    record: Record<string, unknown> | null,
    containerKey: string,
    nestedKey: string,
): string | null => readString(asRecord(record?.[containerKey]), nestedKey);

export const firstNonNull = <T>(values: Array<T | null>): T | null => {
    for (const value of values) {
        if (value !== null) {
            return value;
        }
    }
    return null;
};

export const resolveHostFromLocation = (locationHref: string, fallbackHost: string) => {
    try {
        const host = new URL(locationHref).hostname;
        return host.length > 0 ? host : fallbackHost;
    } catch {
        return fallbackHost;
    }
};

export const ensureUniqueFilename = (filename: string, used: Set<string>) => {
    const base = filename.trim() || 'conversation_export';
    if (!used.has(base)) {
        used.add(base);
        return base;
    }

    let suffix = 2;
    while (used.has(`${base}_${suffix}`)) {
        suffix += 1;
    }

    const next = `${base}_${suffix}`;
    used.add(next);
    return next;
};
