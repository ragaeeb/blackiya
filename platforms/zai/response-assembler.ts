import type { ConversationData } from '@/utils/types';
import { isZaiConversationId, ZAI_HOST } from './constants';
import { mergeZaiConversationPayloads, parseZaiConversationDetail } from './parser';
import { evaluateZaiReadiness } from './readiness';

const DEFAULT_MAX_ENTRIES = 12;
const DEFAULT_MAX_BYTES_PER_ENTRY = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 48 * 1024 * 1024;
export const ZAI_RESPONSE_ASSEMBLER_MAX_AGE_MS = 5 * 60 * 1000;

type ZaiConversationResponseAssemblerOptions = {
    maxEntries?: number;
    maxBytesPerEntry?: number;
    maxTotalBytes?: number;
    maxAgeMs?: number;
    now?: () => number;
    schedulePrune?: (callback: () => void, delayMs: number) => unknown;
    cancelPrune?: (handle: unknown) => void;
};

type ZaiObservedResponse = {
    url: string;
    method: string;
    responseText: string;
    requestBody?: string;
};

type DetailResponse = {
    responseText: string;
    byteLength: number;
};

type BatchResponse = {
    requestBody: string;
    responseText: string;
    byteLength: number;
};

type ResponseEntry = {
    detail: DetailResponse | null;
    batch: BatchResponse | null;
    byteLength: number;
    updatedAt: number;
};

type ZaiEndpoint = {
    kind: 'detail' | 'messages_batch';
    conversationId: string;
};

const DETAIL_PATH_PATTERN = /^\/api\/v1\/chats\/([^/]+)$/;
const MESSAGES_BATCH_PATH_PATTERN = /^\/api\/v1\/chats\/([^/]+)\/messages\/batch$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

const positiveInteger = (value: number | undefined, fallback: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(1, Math.floor(value));
};

const boundedByteLength = (value: string, maxBytes: number): number | null => {
    if (value.length > maxBytes) {
        return null;
    }
    const length = new TextEncoder().encode(value).byteLength;
    return length <= maxBytes ? length : null;
};

const defaultSchedulePrune = (callback: () => void, delayMs: number): unknown => {
    const handle = setTimeout(callback, delayMs);
    if (typeof handle === 'object' && handle && 'unref' in handle && typeof handle.unref === 'function') {
        handle.unref();
    }
    return handle;
};

const defaultCancelPrune = (handle: unknown): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
};

const parseMessageVersion = (responseText: string): number | null => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(responseText);
    } catch {
        return null;
    }
    if (!isRecord(parsed) || typeof parsed.message_version !== 'number' || !Number.isFinite(parsed.message_version)) {
        return null;
    }
    return parsed.message_version;
};

const parseEndpoint = (url: string): ZaiEndpoint | null => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (
        parsed.protocol !== 'https:' ||
        parsed.hostname !== ZAI_HOST ||
        parsed.port ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
    ) {
        return null;
    }

    for (const [kind, pattern] of [
        ['detail', DETAIL_PATH_PATTERN],
        ['messages_batch', MESSAGES_BATCH_PATH_PATTERN],
    ] as const) {
        const conversationId = parsed.pathname.match(pattern)?.[1];
        if (isZaiConversationId(conversationId)) {
            return { kind, conversationId };
        }
    }
    return null;
};

const parseRequestedIds = (requestBody: string | undefined): string[] | null => {
    if (!requestBody) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(requestBody);
    } catch {
        return null;
    }
    if (
        !isRecord(parsed) ||
        Object.keys(parsed).length !== 1 ||
        !Array.isArray(parsed.ids) ||
        parsed.ids.length === 0
    ) {
        return null;
    }
    if (!parsed.ids.every(isZaiConversationId) || new Set(parsed.ids).size !== parsed.ids.length) {
        return null;
    }
    return parsed.ids;
};

const sameIdSet = (left: string[], right: string[]): boolean => {
    if (left.length !== right.length) {
        return false;
    }
    const rightSet = new Set(right);
    return left.every((id) => rightSet.has(id));
};

const isDeclaredCurrentReachableLeaf = (data: ConversationData): boolean => {
    const current = data.mapping[data.current_node];
    if (current?.children.length !== 0) {
        return false;
    }

    const visited = new Set<string>();
    let nodeId: string | null = data.current_node;
    while (nodeId) {
        if (visited.has(nodeId)) {
            return false;
        }
        visited.add(nodeId);
        const node: ConversationData['mapping'][string] | undefined = data.mapping[nodeId];
        if (!node) {
            return false;
        }
        nodeId = node.parent;
    }
    return visited.size > 0;
};

const isReadyTerminal = (data: ConversationData): boolean => {
    const readiness = evaluateZaiReadiness(data);
    return readiness.ready && readiness.terminal;
};

export class ZaiConversationResponseAssembler {
    private readonly entries = new Map<string, ResponseEntry>();
    private readonly maxEntries: number;
    private readonly maxBytesPerEntry: number;
    private readonly maxTotalBytes: number;
    private readonly maxAgeMs: number;
    private readonly now: () => number;
    private readonly schedulePruneCallback: (callback: () => void, delayMs: number) => unknown;
    private readonly cancelPruneCallback: (handle: unknown) => void;
    private pruneHandle: unknown | null = null;
    private totalBytes = 0;

    constructor(options: ZaiConversationResponseAssemblerOptions = {}) {
        this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
        this.maxBytesPerEntry = positiveInteger(options.maxBytesPerEntry, DEFAULT_MAX_BYTES_PER_ENTRY);
        this.maxTotalBytes = Math.max(
            this.maxBytesPerEntry,
            positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES),
        );
        this.maxAgeMs = positiveInteger(options.maxAgeMs, ZAI_RESPONSE_ASSEMBLER_MAX_AGE_MS);
        this.now = options.now ?? Date.now;
        this.schedulePruneCallback = options.schedulePrune ?? defaultSchedulePrune;
        this.cancelPruneCallback = options.cancelPrune ?? defaultCancelPrune;
    }

    ingest(input: ZaiObservedResponse): ConversationData | null {
        const now = this.now();
        this.pruneExpired(now);
        try {
            const endpoint = parseEndpoint(input.url);
            const responseBytes = boundedByteLength(input.responseText, this.maxBytesPerEntry);
            if (!endpoint || !input.responseText || responseBytes === null) {
                return null;
            }

            if (endpoint.kind === 'detail') {
                return input.method.toUpperCase() === 'GET'
                    ? this.ingestDetail(endpoint.conversationId, input.responseText, responseBytes, now)
                    : null;
            }
            return input.method.toUpperCase() === 'POST'
                ? this.ingestBatch(endpoint.conversationId, input.requestBody, input.responseText, responseBytes, now)
                : null;
        } finally {
            this.scheduleExpiryPrune();
        }
    }

    clear(): void {
        this.entries.clear();
        this.totalBytes = 0;
        this.scheduleExpiryPrune();
    }

    private ingestDetail(
        conversationId: string,
        responseText: string,
        responseBytes: number,
        now: number,
    ): ConversationData | null {
        const detail = parseZaiConversationDetail(responseText, conversationId);
        if (!detail) {
            return null;
        }
        const existing = this.entries.get(conversationId);
        const previousDetailBytes = existing?.detail?.byteLength ?? 0;
        const nextByteLength = (existing?.byteLength ?? 0) - previousDetailBytes + responseBytes;
        if (nextByteLength > this.maxBytesPerEntry || nextByteLength > this.maxTotalBytes) {
            return null;
        }

        this.deleteEntry(conversationId);
        const entry: ResponseEntry = {
            detail: { responseText, byteLength: responseBytes },
            batch: existing?.batch ?? null,
            byteLength: nextByteLength,
            updatedAt: now,
        };
        this.entries.set(conversationId, entry);
        this.totalBytes += nextByteLength;
        this.enforceBounds();
        return this.entries.has(conversationId) ? this.assemble(conversationId, entry) : null;
    }

    private ingestBatch(
        conversationId: string,
        requestBody: string | undefined,
        responseText: string,
        responseBytes: number,
        now: number,
    ): ConversationData | null {
        const requestedIds = parseRequestedIds(requestBody);
        if (!requestedIds || !requestBody) {
            return null;
        }
        const requestBytes = boundedByteLength(requestBody, this.maxBytesPerEntry);
        if (requestBytes === null) {
            return null;
        }
        const batchBytes = requestBytes + responseBytes;
        const existing = this.entries.get(conversationId);
        const previousBatchBytes = existing?.batch?.byteLength ?? 0;
        const nextByteLength = (existing?.byteLength ?? 0) - previousBatchBytes + batchBytes;
        if (nextByteLength > this.maxBytesPerEntry || nextByteLength > this.maxTotalBytes) {
            return null;
        }

        this.deleteEntry(conversationId);
        const entry: ResponseEntry = {
            detail: existing?.detail ?? null,
            batch: { requestBody, responseText, byteLength: batchBytes },
            byteLength: nextByteLength,
            updatedAt: now,
        };
        this.entries.set(conversationId, entry);
        this.totalBytes += nextByteLength;
        this.enforceBounds();
        return this.entries.has(conversationId) ? this.assemble(conversationId, entry) : null;
    }

    private assemble(conversationId: string, entry: ResponseEntry): ConversationData | null {
        if (!entry.detail || !entry.batch) {
            return null;
        }
        const requestedIds = parseRequestedIds(entry.batch.requestBody);
        const detail = parseZaiConversationDetail(entry.detail.responseText, conversationId);
        const detailRevision = parseMessageVersion(entry.detail.responseText);
        const batchRevision = parseMessageVersion(entry.batch.responseText);
        if (
            !requestedIds ||
            !detail ||
            detailRevision === null ||
            batchRevision === null ||
            detailRevision !== batchRevision ||
            !sameIdSet(requestedIds, Object.keys(detail.mapping))
        ) {
            return null;
        }

        const merged = mergeZaiConversationPayloads(
            entry.detail.responseText,
            entry.batch.responseText,
            conversationId,
        );
        if (!merged || !sameIdSet(requestedIds, Object.keys(merged.mapping))) {
            return null;
        }
        if (!isDeclaredCurrentReachableLeaf(merged) || !isReadyTerminal(merged)) {
            return null;
        }

        this.deleteEntry(conversationId);
        return merged;
    }

    private pruneExpired(now: number): void {
        for (const [conversationId, entry] of this.entries) {
            if (now - entry.updatedAt >= this.maxAgeMs) {
                this.deleteEntry(conversationId);
            }
        }
    }

    private scheduleExpiryPrune(): void {
        if (this.pruneHandle !== null) {
            this.cancelPruneCallback(this.pruneHandle);
            this.pruneHandle = null;
        }
        if (this.entries.size === 0) {
            return;
        }

        let earliestExpiry = Number.POSITIVE_INFINITY;
        for (const entry of this.entries.values()) {
            earliestExpiry = Math.min(earliestExpiry, entry.updatedAt + this.maxAgeMs);
        }
        const delayMs = Math.max(0, earliestExpiry - this.now());
        this.pruneHandle = this.schedulePruneCallback(() => {
            this.pruneHandle = null;
            this.pruneExpired(this.now());
            this.scheduleExpiryPrune();
        }, delayMs);
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
