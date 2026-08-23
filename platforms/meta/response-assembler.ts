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

type StoredResponse = {
    responseText: string;
    byteLength: number;
};

type ResponseEntry = {
    initialResponse: StoredResponse | null;
    paginationResponses: Map<string, StoredResponse>;
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

const parsePayload = (value: string): unknown => {
    const candidates = [value, ...value.split(/\r?\n/)]
        .map((candidate) => candidate.replace(/^for \(;;\);/, '').trim())
        .filter((candidate) => candidate.startsWith('{'));
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate) as unknown;
        } catch {}
    }
    return null;
};

const isResponseForConversation = (responseText: string, conversationId: string): boolean => {
    const payload = parsePayload(responseText);
    return (
        isRecord(payload) &&
        isRecord(payload.data) &&
        isRecord(payload.data.conversation) &&
        payload.data.conversation.id === conversationId &&
        getPageInfoFromPayload(payload) !== null
    );
};

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
        const existing = this.entries.get(conversationId);
        const previousInitialBytes = existing?.initialResponse?.byteLength ?? 0;
        const nextByteLength = (existing?.byteLength ?? 0) - previousInitialBytes + responseBytes;
        if (nextByteLength > this.maxBytesPerEntry || nextByteLength > this.maxTotalBytes) {
            return null;
        }

        this.deleteEntry(conversationId);
        const entry: ResponseEntry = {
            initialResponse: { responseText, byteLength: responseBytes },
            paginationResponses: existing?.paginationResponses ?? new Map(),
            byteLength: nextByteLength,
            updatedAt: now,
        };
        this.entries.set(conversationId, entry);
        this.totalBytes += nextByteLength;
        this.enforceBounds();
        const assembled = this.entries.has(conversationId) ? this.parseEntry(entry) : null;
        return assembled && isReadyTerminal(assembled) ? assembled : null;
    }

    private ingestPagination(
        conversationId: string,
        before: string,
        responseText: string,
        now: number,
    ): ConversationData | null {
        if (!isResponseForConversation(responseText, conversationId)) {
            return null;
        }
        const existing = this.entries.get(conversationId);
        const paginationResponses = existing?.paginationResponses ?? new Map<string, StoredResponse>();
        if (!paginationResponses.has(before) && paginationResponses.size >= this.maxPagesPerEntry) {
            return null;
        }

        const responseBytes = byteLength(responseText);
        const previousPageBytes = paginationResponses.get(before)?.byteLength ?? 0;
        const nextByteLength = (existing?.byteLength ?? 0) - previousPageBytes + responseBytes;
        if (nextByteLength > this.maxBytesPerEntry || nextByteLength > this.maxTotalBytes) {
            return null;
        }

        this.deleteEntry(conversationId);
        const nextPaginationResponses = new Map(paginationResponses);
        nextPaginationResponses.set(before, { responseText, byteLength: responseBytes });
        const entry: ResponseEntry = {
            initialResponse: existing?.initialResponse ?? null,
            paginationResponses: nextPaginationResponses,
            byteLength: nextByteLength,
            updatedAt: now,
        };
        this.entries.set(conversationId, entry);
        this.totalBytes += nextByteLength;
        this.enforceBounds();
        const parsed = this.entries.has(conversationId) ? this.parseEntry(entry) : null;
        return parsed && isReadyTerminal(parsed) ? parsed : null;
    }

    private parseEntry(entry: ResponseEntry): ConversationData | null {
        if (!entry.initialResponse) {
            return null;
        }
        const orderedResponses: string[] = [];
        const visitedCursors = new Set<string>();
        let parsed = parseMetaConversationArchive(entry.initialResponse.responseText, orderedResponses);
        while (parsed) {
            const pageInfo = getOldestPageInfo(parsed);
            if (!pageInfo) {
                return null;
            }
            if (!pageInfo.hasPreviousPage) {
                return parsed;
            }
            const cursor = pageInfo.startCursor;
            if (!cursor || visitedCursors.has(cursor)) {
                return null;
            }
            const page = entry.paginationResponses.get(cursor);
            if (!page) {
                return parsed;
            }
            visitedCursors.add(cursor);
            orderedResponses.push(page.responseText);
            parsed = parseMetaConversationArchive(entry.initialResponse.responseText, orderedResponses);
        }
        return null;
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
