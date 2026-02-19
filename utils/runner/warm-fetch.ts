/**
 * Warm-fetch utilities — proactively fetches canonical conversation data from
 * the platform API and ingests the response into the interception cache.
 *
 * Dependencies are injected so the functions are unit-testable without a live
 * runner closure.
 */

import type { PlatformReadiness } from '@/platforms/types';
import { logger } from '@/utils/logger';
import { shouldUseCachedConversationForWarmFetch } from '@/utils/sfe/capture-fidelity';
import type { ExportMeta } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

export type WarmFetchReason = 'initial-load' | 'conversation-switch' | 'stabilization-retry' | 'force-save';

export type WarmFetchDeps = {
    platformName: string;
    /** Returns ordered API URL candidates for the given conversation. */
    getFetchUrlCandidates: (conversationId: string) => string[];
    /** Ingest raw intercepted data for a URL. */
    ingestInterceptedData: (args: { url: string; data: string; platform: string }) => void;
    /** Returns the cached conversation (if any) for the given ID. */
    getConversation: (conversationId: string) => ConversationData | null;
    /** Evaluates readiness for a conversation data object. */
    evaluateReadiness: (data: ConversationData) => PlatformReadiness;
    /** Returns persisted capture metadata for a conversation. */
    getCaptureMeta: (conversationId: string) => ExportMeta;
};

const WARM_FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetches a single API URL and ingests the response.
 * Returns `true` when the fetch succeeded and a conversation was cached.
 */
export const tryWarmFetchCandidate = async (
    conversationId: string,
    reason: WarmFetchReason,
    apiUrl: string,
    deps: WarmFetchDeps,
): Promise<boolean> => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), WARM_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(apiUrl, { credentials: 'include', signal: controller.signal });
        if (!response.ok) {
            logger.info('Warm fetch HTTP error', {
                conversationId,
                reason,
                status: response.status,
                path: new URL(apiUrl, window.location.origin).pathname,
            });
            return false;
        }
        const text = await response.text();
        deps.ingestInterceptedData({ url: apiUrl, data: text, platform: deps.platformName });
        if (!deps.getConversation(conversationId)) {
            return false;
        }
        logger.info('Warm fetch captured conversation', {
            conversationId,
            platform: deps.platformName,
            reason,
            path: new URL(apiUrl, window.location.origin).pathname,
        });
        return true;
    } catch (err) {
        logger.info('Warm fetch network error', {
            conversationId,
            reason,
            error: err instanceof Error ? err.message : String(err),
        });
        return false;
    } finally {
        clearTimeout(timeoutId);
    }
};

/**
 * Tries up to two URL candidates in priority order, returning `true` on the
 * first successful capture.
 */
export const executeWarmFetchCandidates = async (
    conversationId: string,
    reason: WarmFetchReason,
    deps: WarmFetchDeps,
): Promise<boolean> => {
    const candidates = deps.getFetchUrlCandidates(conversationId);
    if (candidates.length === 0) {
        return false;
    }
    for (const apiUrl of candidates.slice(0, 2)) {
        if (await tryWarmFetchCandidate(conversationId, reason, apiUrl, deps)) {
            return true;
        }
    }
    logger.info('Warm fetch all candidates failed', { conversationId, reason });
    return false;
};

/**
 * High-level entry point used by the runner.
 * Skips the network request when the cache already holds a ready canonical
 * result. Deduplicates concurrent in-flight requests via a shared promise map.
 */
export const warmFetchConversationSnapshot = (
    conversationId: string,
    reason: WarmFetchReason,
    deps: WarmFetchDeps,
    inFlight: Map<string, Promise<boolean>>,
): Promise<boolean> => {
    const cached = deps.getConversation(conversationId);
    const captureMeta = deps.getCaptureMeta(conversationId);
    if (cached && shouldUseCachedConversationForWarmFetch(deps.evaluateReadiness(cached), captureMeta)) {
        logger.info('Warm fetch skipped: cache is ready+canonical', { conversationId, reason });
        return Promise.resolve(true);
    }

    const key = `${deps.platformName}:${conversationId}`;
    const existing = inFlight.get(key);
    if (existing) {
        logger.info('Warm fetch dedup hit (shared in-flight promise)', { conversationId, reason });
        return existing;
    }

    const run = executeWarmFetchCandidates(conversationId, reason, deps).finally(() => {
        inFlight.delete(key);
    });
    inFlight.set(key, run);
    return run;
};
