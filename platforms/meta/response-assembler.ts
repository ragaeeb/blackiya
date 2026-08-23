import type { ConversationData } from '@/utils/types';
import { parseMetaConversationArchive } from './parser';
import { evaluateMetaReadiness } from './readiness';
import { extractMetaGraphqlRequestContext, isMetaConversationId } from './request';

const DEFAULT_MAX_ENTRIES = 12;
const DEFAULT_MAX_PAGES_PER_ENTRY = 100;
const DEFAULT_MAX_BYTES_PER_ENTRY = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 48 * 1024 * 1024;
export const META_RESPONSE_ASSEMBLER_MAX_AGE_MS = 5 * 60 * 1000;

type MetaGraphqlResponseAssemblerOptions = {
    maxEntries?: number;
    maxPagesPerEntry?: number;
    maxBytesPerEntry?: number;
    maxTotalBytes?: number;
    maxAgeMs?: number;
    now?: () => number;
};

type ResponseEntry = {
    initialResponse: string;
    paginationResponses: string[];
    byteLength: number;
    updatedAt: number;
};

type PageInfo = {
    hasPreviousPage: boolean;
    startCursor: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

const positiveInteger = (value: number | undefined, fallback: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(1, Math.floor(value));
};

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const getPageInfoFromPayload = (payload: unknown): PageInfo | null => {
    if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.conversation)) {
        return null;
    }
    const conversation = payload.data.conversation;
    if (!isRecord(conversation.messages) || !isRecord(conversation.messages.pageInfo)) {
        return null;
    }
    const pageInfo = conversation.messages.pageInfo;
    if (typeof pageInfo.hasPreviousPage !== 'boolean') {
        return null;
    }
    if (pageInfo.startCursor !== null && typeof pageInfo.startCursor !== 'string') {
        return null;
    }
    return {
        hasPreviousPage: pageInfo.hasPreviousPage,
        startCursor: pageInfo.startCursor,
    };
};

const getOldestPageInfo = (data: ConversationData): PageInfo | null => {
    const rawPayload = data.raw_payload;
    if (!isRecord(rawPayload)) {
        return null;
    }
    if (Array.isArray(rawPayload.pagination_responses)) {
        const oldest = rawPayload.pagination_responses.at(-1);
        return getPageInfoFromPayload(oldest);
    }
    return getPageInfoFromPayload(rawPayload);
};

const isReadyTerminal = (data: ConversationData): boolean => {
    const readiness = evaluateMetaReadiness(data);
    return readiness.ready && readiness.terminal;
};

export class MetaGraphqlResponseAssembler {
    private readonly entries = new Map<string, ResponseEntry>();
    private readonly maxEntries: number;
    private readonly maxPagesPerEntry: number;
    private readonly maxBytesPerEntry: number;
    private readonly maxTotalBytes: number;
    private readonly maxAgeMs: number;
    private readonly now: () => number;
    private totalBytes = 0;

    constructor(options: MetaGraphqlResponseAssemblerOptions = {}) {
        this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
        this.maxPagesPerEntry = positiveInteger(options.maxPagesPerEntry, DEFAULT_MAX_PAGES_PER_ENTRY);
        this.maxBytesPerEntry = positiveInteger(options.maxBytesPerEntry, DEFAULT_MAX_BYTES_PER_ENTRY);
        this.maxTotalBytes = Math.max(
            this.maxBytesPerEntry,
            positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES),
        );
        this.maxAgeMs = positiveInteger(options.maxAgeMs, META_RESPONSE_ASSEMBLER_MAX_AGE_MS);
        this.now = options.now ?? Date.now;
    }

    ingest(requestBody: string, responseText: string): ConversationData | null {
        const now = this.now();
        this.pruneExpired(now);
        const context = extractMetaGraphqlRequestContext(requestBody);
        if (!context || responseText.length === 0) {
            return null;
        }

        if (context.kind === 'conversation-detail') {
            return this.ingestInitial(context.conversationId, responseText, now);
        }
        return this.ingestPagination(context.conversationId, context.before, responseText, now);
    }

    getReadyConversation(conversationId: string): ConversationData | null {
        if (!isMetaConversationId(conversationId)) {
            return null;
        }
        const now = this.now();
        this.pruneExpired(now);
        const entry = this.entries.get(conversationId);
        if (!entry) {
            return null;
        }
        const parsed = this.parseEntry(entry);
        return parsed && isReadyTerminal(parsed) ? parsed : null;
    }

    clear(): void {
        this.entries.clear();
        this.totalBytes = 0;
    }

    private ingestInitial(conversationId: string, responseText: string, now: number): ConversationData | null {
        const parsed = parseMetaConversationArchive(responseText, []);
        if (!parsed || parsed.conversation_id !== conversationId) {
            return null;
        }
        const responseBytes = byteLength(responseText);
        if (responseBytes > this.maxBytesPerEntry || responseBytes > this.maxTotalBytes) {
            return null;
        }

        this.deleteEntry(conversationId);
        this.entries.set(conversationId, {
            initialResponse: responseText,
            paginationResponses: [],
            byteLength: responseBytes,
            updatedAt: now,
        });
        this.totalBytes += responseBytes;
        this.enforceBounds();
        return this.entries.has(conversationId) && isReadyTerminal(parsed) ? parsed : null;
    }

    private ingestPagination(
        conversationId: string,
        before: string,
        responseText: string,
        now: number,
    ): ConversationData | null {
        const entry = this.entries.get(conversationId);
        if (!entry || entry.paginationResponses.length >= this.maxPagesPerEntry) {
            return null;
        }
        const current = this.parseEntry(entry);
        const pageInfo = current ? getOldestPageInfo(current) : null;
        if (!pageInfo?.hasPreviousPage || pageInfo.startCursor !== before) {
            return null;
        }

        const responseBytes = byteLength(responseText);
        const nextByteLength = entry.byteLength + responseBytes;
        if (nextByteLength > this.maxBytesPerEntry || responseBytes > this.maxTotalBytes) {
            return null;
        }
        const paginationResponses = [...entry.paginationResponses, responseText];
        const parsed = parseMetaConversationArchive(entry.initialResponse, paginationResponses);
        if (!parsed || parsed.conversation_id !== conversationId) {
            return null;
        }

        this.deleteEntry(conversationId);
        this.entries.set(conversationId, {
            initialResponse: entry.initialResponse,
            paginationResponses,
            byteLength: nextByteLength,
            updatedAt: now,
        });
        this.totalBytes += nextByteLength;
        this.enforceBounds();
        return this.entries.has(conversationId) && isReadyTerminal(parsed) ? parsed : null;
    }

    private parseEntry(entry: ResponseEntry): ConversationData | null {
        return parseMetaConversationArchive(entry.initialResponse, entry.paginationResponses);
    }

    private pruneExpired(now: number): void {
        for (const [conversationId, entry] of this.entries) {
            if (now - entry.updatedAt >= this.maxAgeMs) {
                this.deleteEntry(conversationId);
            }
        }
    }

    private enforceBounds(): void {
        while (this.entries.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
            const oldestConversationId = this.entries.keys().next().value as string | undefined;
            if (!oldestConversationId) {
                return;
            }
            this.deleteEntry(oldestConversationId);
        }
    }

    private deleteEntry(conversationId: string): void {
        const entry = this.entries.get(conversationId);
        if (!entry) {
            return;
        }
        this.totalBytes -= entry.byteLength;
        this.entries.delete(conversationId);
    }
}
