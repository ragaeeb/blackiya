import { browser } from 'wxt/browser';
import type { HeaderRecord } from '@/utils/proactive-fetch-headers';

const PLATFORM_HEADER_CACHE_KEY = 'userSettings.platformHeaderCache.v1';
const PLATFORM_HEADER_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_PLATFORM_CACHE_ENTRIES = 10;

type CachedPlatformHeaderEntry = {
    headers: HeaderRecord;
    capturedAt: number;
};

type CachedPlatformHeaderMap = Record<string, CachedPlatformHeaderEntry>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const normalizeHeaderRecord = (value: unknown): HeaderRecord | null => {
    if (!isRecord(value)) {
        return null;
    }
    const normalized: HeaderRecord = {};
    for (const [key, raw] of Object.entries(value)) {
        if (typeof raw !== 'string' || key.trim().length === 0 || raw.trim().length === 0) {
            continue;
        }
        normalized[key.toLowerCase()] = raw;
    }
    return Object.keys(normalized).length > 0 ? normalized : null;
};

const normalizeCacheMap = (value: unknown): CachedPlatformHeaderMap => {
    if (!isRecord(value)) {
        return {};
    }
    const normalized: CachedPlatformHeaderMap = {};
    for (const [platformName, rawEntry] of Object.entries(value)) {
        if (!isRecord(rawEntry)) {
            continue;
        }
        const headers = normalizeHeaderRecord(rawEntry.headers);
        const capturedAt =
            typeof rawEntry.capturedAt === 'number' && Number.isFinite(rawEntry.capturedAt) ? rawEntry.capturedAt : 0;
        if (!headers || capturedAt <= 0) {
            continue;
        }
        normalized[platformName] = { headers, capturedAt };
    }
    return normalized;
};

const readCacheMap = async (): Promise<CachedPlatformHeaderMap> => {
    try {
        const result = await browser.storage.local.get(PLATFORM_HEADER_CACHE_KEY);
        return normalizeCacheMap(result?.[PLATFORM_HEADER_CACHE_KEY]);
    } catch {
        return {};
    }
};

const writeCacheMap = async (cacheMap: CachedPlatformHeaderMap): Promise<void> => {
    try {
        await browser.storage.local.set({
            [PLATFORM_HEADER_CACHE_KEY]: cacheMap,
        });
    } catch {
        // Best-effort cache only.
    }
};

const trimCacheMap = (cacheMap: CachedPlatformHeaderMap): CachedPlatformHeaderMap => {
    const entries = Object.entries(cacheMap);
    if (entries.length <= MAX_PLATFORM_CACHE_ENTRIES) {
        return cacheMap;
    }
    const sorted = entries.sort((a, b) => b[1].capturedAt - a[1].capturedAt);
    return Object.fromEntries(sorted.slice(0, MAX_PLATFORM_CACHE_ENTRIES));
};

export const readPlatformHeadersFromCache = async (platformName: string): Promise<HeaderRecord | undefined> => {
    if (!platformName) {
        return undefined;
    }
    const cacheMap = await readCacheMap();
    const entry = cacheMap[platformName];
    if (!entry) {
        return undefined;
    }
    const ageMs = Date.now() - entry.capturedAt;
    if (ageMs > PLATFORM_HEADER_CACHE_MAX_AGE_MS) {
        delete cacheMap[platformName];
        await writeCacheMap(cacheMap);
        return undefined;
    }
    return entry.headers;
};

export const writePlatformHeadersToCache = async (
    platformName: string,
    headers: HeaderRecord | undefined,
): Promise<void> => {
    const normalized = normalizeHeaderRecord(headers);
    if (!platformName || !normalized) {
        return;
    }
    const cacheMap = await readCacheMap();
    cacheMap[platformName] = {
        headers: normalized,
        capturedAt: Date.now(),
    };
    await writeCacheMap(trimCacheMap(cacheMap));
};

export const clearPlatformHeadersCache = async (platformName: string): Promise<void> => {
    if (!platformName) {
        return;
    }
    const cacheMap = await readCacheMap();
    if (!(platformName in cacheMap)) {
        return;
    }
    delete cacheMap[platformName];
    await writeCacheMap(cacheMap);
};
