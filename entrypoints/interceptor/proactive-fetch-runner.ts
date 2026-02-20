import {
    getApiUrlCandidates,
    isCapturedConversationReady,
    isFetchReady,
} from '@/entrypoints/interceptor/conversation-utils';
import { safePathname } from '@/entrypoints/interceptor/discovery';
import { ProactiveFetcher } from '@/entrypoints/interceptor/proactive-fetcher';
import type { LLMPlatform } from '@/platforms/types';
import { setBoundedMapValue, touchBoundedMapKey } from '@/utils/bounded-collections';
import { type HeaderRecord, mergeHeaderRecords } from '@/utils/proactive-fetch-headers';
import type { ConversationData } from '@/utils/types';

type EmitterDeps = {
    isAttemptDisposed: (attemptId: string | undefined) => boolean;
    shouldLogTransient: (key: string, intervalMs?: number) => boolean;
    shouldEmitCapturedPayload: (adapterName: string, url: string, payload: string, intervalMs?: number) => boolean;
    log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
    emitCapturePayload: (url: string, data: string, platform: string, attemptId?: string) => void;
};

const BACKOFF_SCHEDULE_MS = [900, 1800, 3200, 5000, 7000, 9000, 12000, 15000];
const SUCCESS_COOLDOWN_MS = 20_000;

/**
 * Manages proactive background fetches of conversation data after a response
 * finishes. Uses exponential-ish backoff and deduplicates concurrent fetches
 * per conversation key.
 */
export class ProactiveFetchRunner {
    private readonly fetcher: ProactiveFetcher;
    private readonly successAtByKey = new Map<string, number>();
    private readonly headersByKey = new Map<string, HeaderRecord>();

    constructor(
        private readonly originalFetch: typeof fetch,
        private readonly resolveAttemptIdForConversation: (conversationId?: string, platformName?: string) => string,
        private readonly emitter: EmitterDeps,
        private readonly maxDedupeEntries: number,
    ) {
        this.fetcher = new ProactiveFetcher();
    }

    /** Triggers a proactive fetch for the conversation associated with `triggerUrl`, if eligible. */
    readonly trigger = async (adapter: LLMPlatform, triggerUrl: string, requestHeaders?: HeaderRecord) => {
        if (!isFetchReady(adapter)) {
            return;
        }
        const conversationId = adapter.extractConversationIdFromUrl?.(triggerUrl);
        if (!conversationId) {
            return;
        }

        const key = `${adapter.name}:${conversationId}`;

        const merged = mergeHeaderRecords(this.headersByKey.get(key), requestHeaders);
        if (merged) {
            this.headersByKey.set(key, merged);
        }

        await this.fetcher.withInFlight(key, async () => {
            try {
                if (Date.now() - (this.successAtByKey.get(key) ?? 0) < SUCCESS_COOLDOWN_MS) {
                    touchBoundedMapKey(this.successAtByKey, key);
                    return;
                }
                this.emitter.log('info', `trigger ${adapter.name} ${conversationId}`);
                const attemptId = this.resolveAttemptIdForConversation(conversationId, adapter.name);
                const succeeded = await this.runWithBackoff(adapter, conversationId, key, attemptId);
                if (!succeeded) {
                    this.emitter.log('info', `fetch gave up ${conversationId}`);
                }
            } finally {
                this.headersByKey.delete(key);
            }
        });
    };

    private readonly runWithBackoff = async (
        adapter: LLMPlatform,
        conversationId: string,
        key: string,
        attemptId: string,
    ) => {
        for (let attempt = 0; attempt < BACKOFF_SCHEDULE_MS.length; attempt++) {
            if (this.emitter.isAttemptDisposed(attemptId)) {
                return false;
            }
            await delay(BACKOFF_SCHEDULE_MS[attempt]);
            const apiUrls = getApiUrlCandidates(adapter, conversationId);
            const requestHeaders = this.headersByKey.get(key);
            for (const apiUrl of apiUrls) {
                const success = await this.tryFetch(
                    adapter,
                    conversationId,
                    attemptId,
                    attempt + 1,
                    apiUrl,
                    requestHeaders,
                );
                if (success) {
                    setBoundedMapValue(this.successAtByKey, key, Date.now(), this.maxDedupeEntries);
                    return true;
                }
            }
        }
        return false;
    };

    private readonly tryFetch = async (
        adapter: LLMPlatform,
        conversationId: string,
        attemptId: string,
        attempt: number,
        apiUrl: string,
        requestHeaders?: HeaderRecord,
    ) => {
        if (this.emitter.isAttemptDisposed(attemptId)) {
            return false;
        }
        try {
            const response = await this.originalFetch(apiUrl, { credentials: 'include', headers: requestHeaders });
            if (!response.ok) {
                this.logFetchStatus(conversationId, apiUrl, response.status, attempt);
                return false;
            }
            const text = await response.text();
            const parsed = this.parseConversation(adapter, apiUrl, text);
            if (!parsed) {
                return false;
            }
            return this.emitIfReady(adapter, parsed, apiUrl, conversationId, attemptId, text.length);
        } catch (error) {
            if (this.emitter.shouldLogTransient(`fetch:error:${conversationId}`, 5000)) {
                this.emitter.log('warn', `fetch err ${conversationId}`, {
                    attempt,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            return false;
        }
    };

    private readonly parseConversation = (adapter: LLMPlatform, apiUrl: string, text: string) => {
        try {
            return adapter.parseInterceptedData(text, apiUrl);
        } catch (error) {
            if (this.emitter.shouldLogTransient(`fetch:parse:${adapter.name}:${safePathname(apiUrl)}`, 5000)) {
                this.emitter.log('warn', `fetch parse err ${adapter.name}`, {
                    path: safePathname(apiUrl),
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            return null;
        }
    };

    private readonly emitIfReady = (
        adapter: LLMPlatform,
        parsed: ConversationData,
        apiUrl: string,
        conversationId: string,
        attemptId: string,
        byteSize: number,
    ) => {
        if (!isCapturedConversationReady(adapter, parsed)) {
            return false;
        }
        const payload = JSON.stringify(parsed);
        if (!this.emitter.shouldEmitCapturedPayload(adapter.name, apiUrl, payload, 3000)) {
            return false;
        }
        this.emitter.log('info', `fetched ${conversationId} ${byteSize}b`, { path: safePathname(apiUrl) });
        this.emitter.emitCapturePayload(apiUrl, payload, adapter.name, attemptId);
        return true;
    };

    private readonly logFetchStatus = (conversationId: string, apiUrl: string, status: number, attempt: number) => {
        const path = safePathname(apiUrl);
        if (!this.emitter.shouldLogTransient(`fetch:status:${conversationId}:${path}:${status}`, 5000)) {
            return;
        }
        this.emitter.log('info', 'fetch response', { conversationId, ok: false, status, attempt });
    };
}

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
