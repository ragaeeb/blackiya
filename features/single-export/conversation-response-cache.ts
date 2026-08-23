import type { ConversationData } from '@/utils/types';

const DEFAULT_MAX_ENTRIES = 12;
const DEFAULT_MAX_BYTES_PER_ENTRY = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 48 * 1024 * 1024;
export const CONVERSATION_RESPONSE_MAX_AGE_MS = 5 * 60 * 1000;

type CacheOptions = {
    maxEntries?: number;
    maxBytesPerEntry?: number;
    maxTotalBytes?: number;
    maxAgeMs?: number;
    now?: () => number;
};

type CacheEntry = {
    serialized: string;
    byteLength: number;
    updatedAt: number;
};

const keyFor = (platformName: string, conversationId: string) => `${platformName}\u0000${conversationId}`;

export class ConversationResponseCache {
    private readonly entries = new Map<string, CacheEntry>();
    private readonly maxEntries: number;
    private readonly maxBytesPerEntry: number;
    private readonly maxTotalBytes: number;
    private readonly maxAgeMs: number;
    private readonly now: () => number;
    private totalBytes = 0;

    constructor(options: CacheOptions = {}) {
        this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
        this.maxBytesPerEntry = Math.max(1, Math.floor(options.maxBytesPerEntry ?? DEFAULT_MAX_BYTES_PER_ENTRY));
        this.maxTotalBytes = Math.max(
            this.maxBytesPerEntry,
            Math.floor(options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES),
        );
        this.maxAgeMs = Math.max(1, Math.floor(options.maxAgeMs ?? CONVERSATION_RESPONSE_MAX_AGE_MS));
        this.now = options.now ?? Date.now;
    }

    set(platformName: string, data: ConversationData): boolean {
        if (!platformName.trim() || !data.conversation_id.trim()) {
            return false;
        }
        let serialized: string;
        try {
            serialized = JSON.stringify(data);
        } catch {
            return false;
        }
        const byteLength = new TextEncoder().encode(serialized).byteLength;
        if (byteLength > this.maxBytesPerEntry || byteLength > this.maxTotalBytes) {
            return false;
        }

        const key = keyFor(platformName, data.conversation_id);
        this.deleteKey(key);
        this.entries.set(key, { serialized, byteLength, updatedAt: this.now() });
        this.totalBytes += byteLength;
        this.enforceBounds();
        return this.entries.has(key);
    }

    get(platformName: string, conversationId: string): ConversationData | undefined {
        const key = keyFor(platformName, conversationId);
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }
        if (this.now() - entry.updatedAt >= this.maxAgeMs) {
            this.deleteKey(key);
            return undefined;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        try {
            return JSON.parse(entry.serialized) as ConversationData;
        } catch {
            this.deleteKey(key);
            return undefined;
        }
    }

    clear(): void {
        this.entries.clear();
        this.totalBytes = 0;
    }

    private enforceBounds(): void {
        while (this.entries.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
            const oldestKey = this.entries.keys().next().value as string | undefined;
            if (!oldestKey) {
                return;
            }
            this.deleteKey(oldestKey);
        }
    }

    private deleteKey(key: string): void {
        const existing = this.entries.get(key);
        if (!existing) {
            return;
        }
        this.totalBytes -= existing.byteLength;
        this.entries.delete(key);
    }
}

export const conversationResponseCache = new ConversationResponseCache();
