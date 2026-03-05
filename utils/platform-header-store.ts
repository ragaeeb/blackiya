/**
 * Platform Header Store
 *
 * Centralised in-memory store for forwardable auth/client headers captured
 * from observed platform fetch/XHR requests. All pull paths (proactive-fetch,
 * warm-fetch, stream-done-probe) can read from this store so that follow-up
 * API calls include the same auth context (authorization, oai-device-id, etc.)
 * that the browser's own requests carry.
 *
 * Without these headers, ChatGPT returns 404 for conversation API URLs because
 * cookie-only auth is no longer sufficient.
 *
 * @module utils/platform-header-store
 */

import { type HeaderRecord, mergeHeaderRecords } from '@/utils/proactive-fetch-headers';

const MAX_PLATFORMS = 10;

/**
 * A simple bounded store keyed by platform name. Each platform keeps the
 * latest merged set of forwardable headers seen across intercepted requests.
 */
export class PlatformHeaderStore {
    private readonly headers = new Map<string, HeaderRecord>();

    /** Merges new headers into the existing set for a platform. */
    update(platformName: string, incoming: HeaderRecord | undefined): void {
        if (!incoming || Object.keys(incoming).length === 0) {
            return;
        }
        const existing = this.headers.get(platformName);
        const merged = mergeHeaderRecords(existing, incoming);
        if (merged) {
            this.headers.set(platformName, merged);
            this.enforceCapacity();
        }
    }

    /** Returns the stored headers for a platform, or undefined if none. */
    get(platformName: string): HeaderRecord | undefined {
        return this.headers.get(platformName);
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
}

/** Singleton instance shared across the interceptor and runner. */
export const platformHeaderStore = new PlatformHeaderStore();
