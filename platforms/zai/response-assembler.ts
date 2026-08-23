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
};

type ZaiObservedResponse = {
    url: string;
    method: string;
    responseText: string;
    requestBody?: string;
};

type DetailEntry = {
    responseText: string;
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

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

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
    private readonly entries = new Map<string, DetailEntry>();
    private readonly maxEntries: number;
    private readonly maxBytesPerEntry: number;
    private readonly maxTotalBytes: number;
    private readonly maxAgeMs: number;
    private readonly now: () => number;
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
    }

    ingest(input: ZaiObservedResponse): ConversationData | null {
        const now = this.now();
        this.pruneExpired(now);
        const endpoint = parseEndpoint(input.url);
        if (!endpoint || !input.responseText) {
            return null;
        }

        if (endpoint.kind === 'detail') {
            return input.method.toUpperCase() === 'GET'
                ? this.ingestDetail(endpoint.conversationId, input.responseText, now)
                : null;
        }
        return input.method.toUpperCase() === 'POST'
            ? this.ingestBatch(endpoint.conversationId, input.requestBody, input.responseText)
            : null;
    }

    clear(): void {
        this.entries.clear();
        this.totalBytes = 0;
    }

    private ingestDetail(conversationId: string, responseText: string, now: number): null {
        const detail = parseZaiConversationDetail(responseText, conversationId);
        if (!detail) {
            return null;
        }
        const responseBytes = byteLength(responseText);
        if (responseBytes > this.maxBytesPerEntry || responseBytes > this.maxTotalBytes) {
            return null;
        }

        this.deleteEntry(conversationId);
        this.entries.set(conversationId, { responseText, byteLength: responseBytes, updatedAt: now });
        this.totalBytes += responseBytes;
        this.enforceBounds();
        return null;
    }

    private ingestBatch(conversationId: string, requestBody: string | undefined, responseText: string) {
        const entry = this.entries.get(conversationId);
        const requestedIds = parseRequestedIds(requestBody);
        if (!entry || !requestedIds) {
            return null;
        }

        const detail = parseZaiConversationDetail(entry.responseText, conversationId);
        if (!detail || !sameIdSet(requestedIds, Object.keys(detail.mapping))) {
            return null;
        }
        const combinedBytes = entry.byteLength + byteLength(requestBody ?? '') + byteLength(responseText);
        if (combinedBytes > this.maxBytesPerEntry || combinedBytes > this.maxTotalBytes) {
            return null;
        }

        const merged = mergeZaiConversationPayloads(entry.responseText, responseText, conversationId);
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
