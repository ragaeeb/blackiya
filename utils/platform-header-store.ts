/**
 * Platform Header Store
 *
 * Centralised in-memory store for forwardable auth/client headers captured
 * from observed platform fetch/XHR requests. Click-time export paths can read
 * from this store so follow-up API calls include the same auth context
 * (authorization, oai-device-id, etc.) that the browser's own requests carry.
 *
 * Without these headers, ChatGPT returns 404 for conversation API URLs because
 * cookie-only auth is no longer sufficient.
 *
 * @module utils/platform-header-store
 */

import { type HeaderRecord, mergeHeaderRecords } from '@/utils/proactive-fetch-headers';

const MAX_PLATFORMS = 10;
export const PLATFORM_HEADER_MAX_AGE_MS = 5 * 60 * 1_000;
const IDENTITY_HEADER_NAMES = [
    'authorization',
    'oai-device-id',
    '__secure-next-authdata',
    'x-goog-authuser',
    'x-goog-visitor-id',
] as const;

type HeaderStoreOptions = {
    maxAgeMs?: number;
    now?: () => number;
};

type HeaderEntry = {
    headers: HeaderRecord;
    updatedAt: number;
};

/**
 * A simple bounded store keyed by platform name. Each platform keeps the
 * latest merged set of forwardable headers seen across intercepted requests.
 */
export class PlatformHeaderStore {
    private readonly headers = new Map<string, HeaderEntry>();
    private readonly maxAgeMs: number;
    private readonly now: () => number;

    constructor(options: HeaderStoreOptions = {}) {
        this.maxAgeMs =
            typeof options.maxAgeMs === 'number' && Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0
                ? options.maxAgeMs
                : PLATFORM_HEADER_MAX_AGE_MS;
        this.now = options.now ?? Date.now;
    }

    /** Stores a fresh snapshot, merging only while its identity is unchanged. */
    update(platformName: string, incoming: HeaderRecord | undefined): void {
        if (!incoming || Object.keys(incoming).length === 0) {
            return;
        }
        const normalizedIncoming = Object.fromEntries(
            Object.entries(incoming).map(([name, value]) => [name.toLowerCase(), value]),
        );
        const existing = this.getEntry(platformName, this.now());
        const identityChanged = existing
            ? IDENTITY_HEADER_NAMES.some((name) => {
                  const previous = existing.headers[name];
                  const next = normalizedIncoming[name];
                  return typeof previous === 'string' && typeof next === 'string' && previous !== next;
              })
            : false;
        const merged = identityChanged
            ? normalizedIncoming
            : mergeHeaderRecords(existing?.headers, normalizedIncoming);
        if (merged) {
            this.headers.set(platformName, { headers: merged, updatedAt: this.now() });
            this.enforceCapacity();
        }
    }

    /** Returns a fresh defensive snapshot, or undefined after the TTL expires. */
    get(platformName: string): HeaderRecord | undefined {
        const entry = this.getEntry(platformName, this.now());
        return entry ? { ...entry.headers } : undefined;
    }

    /** Clears all stored headers (e.g. on cleanup). */
    clear(): void {
        this.headers.clear();
    }

    private enforceCapacity(): void {
        while (this.headers.size > MAX_PLATFORMS) {
            const oldestKey = this.headers.keys().next().value as string;
            this.headers.delete(oldestKey);
        }
    }

    private getEntry(platformName: string, now: number): HeaderEntry | undefined {
        const entry = this.headers.get(platformName);
        if (!entry) {
            return undefined;
        }
        if (now - entry.updatedAt >= this.maxAgeMs) {
            this.headers.delete(platformName);
            return undefined;
        }
        return entry;
    }
}

/** Singleton instance shared across the interceptor and runner. */
export const platformHeaderStore = new PlatformHeaderStore();
