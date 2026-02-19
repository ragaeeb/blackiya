/**
 * Calibration capture step execution.
 *
 * Each strategy step (`queue-flush`, `passive-wait`, `endpoint-retry`,
 * `page-snapshot`) is implemented as a standalone async function that
 * receives its dependencies explicitly. The runner orchestrator composes
 * these via `runCalibrationStep`.
 */

import type { LLMPlatform } from '@/platforms/types';
import { logger } from '@/utils/logger';
import type { CalibrationStep } from '@/utils/runner/calibration-runner';
import type { ConversationData } from '@/utils/types';

export type CalibrationMode = 'manual' | 'auto';

export type RawCaptureSnapshot = {
    __blackiyaSnapshotType: 'raw-capture';
    data: string;
    url: string;
    platform?: string;
};

export const isRawCaptureSnapshot = (value: unknown): value is RawCaptureSnapshot => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const c = value as Record<string, unknown>;
    return c.__blackiyaSnapshotType === 'raw-capture' && typeof c.data === 'string' && typeof c.url === 'string';
};

export const isConversationDataLike = (value: unknown): value is ConversationData => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const c = value as Record<string, unknown>;
    return (
        typeof c.conversation_id === 'string' &&
        c.conversation_id.length > 0 &&
        !!c.mapping &&
        typeof c.mapping === 'object'
    );
};

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export type CalibrationCaptureDeps = {
    adapter: LLMPlatform;
    /** True when the current capture state is considered satisfactory. */
    isCaptureSatisfied: (conversationId: string, mode: CalibrationMode) => boolean;
    /** Flush any queued interceptor messages into the cache. */
    flushQueuedMessages: () => void;
    /** Request a page snapshot from the MAIN world. */
    requestSnapshot: (conversationId: string) => Promise<unknown | null>;
    /** Build an isolated DOM snapshot without crossing to the MAIN world. */
    buildIsolatedSnapshot: (conversationId: string) => ConversationData | null;
    /** Ingest a fully parsed ConversationData into the cache. */
    ingestConversationData: (data: ConversationData, source: string) => void;
    /** Ingest raw intercepted bytes for a given URL. */
    ingestInterceptedData: (args: { url: string; data: string; platform: string }) => void;
    /** Returns ordered fetch URL candidates for the given conversation. */
    getFetchUrlCandidates: (conversationId: string) => string[];
    /** Returns the Grok raw-snapshot replay URLs for an original snapshot URL. */
    getRawSnapshotReplayUrls: (conversationId: string, snapshot: { url: string }) => string[];
};

// ---------------------------------------------------------------------------
// passive-wait
// ---------------------------------------------------------------------------

const PASSIVE_WAIT_TIMEOUT_BY_PLATFORM: Record<string, number> = {
    ChatGPT: 1200,
    Gemini: 3500,
    Grok: 3500,
};

const getPassiveWaitTimeoutMs = (platformName: string): number =>
    PASSIVE_WAIT_TIMEOUT_BY_PLATFORM[platformName] ?? 2000;

/**
 * Polls every 250 ms until the capture is satisfied or the platform-specific
 * timeout elapses, flushing the interceptor message queue on each tick.
 */
export const waitForPassiveCapture = async (
    conversationId: string,
    mode: CalibrationMode,
    deps: CalibrationCaptureDeps,
): Promise<boolean> => {
    const timeoutMs = getPassiveWaitTimeoutMs(deps.adapter.name);
    const intervalMs = 250;
    logger.info('Calibration passive wait start', {
        conversationId,
        platform: deps.adapter.name,
        timeoutMs,
    });
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        deps.flushQueuedMessages();
        if (deps.isCaptureSatisfied(conversationId, mode)) {
            logger.info('Calibration passive wait captured', {
                conversationId,
                platform: deps.adapter.name,
                elapsedMs: Date.now() - started,
            });
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    logger.info('Calibration passive wait timeout', { conversationId, platform: deps.adapter.name });
    return false;
};

// ---------------------------------------------------------------------------
// page-snapshot
// ---------------------------------------------------------------------------

/**
 * Waits for the DOM to settle (`quietMs` of no mutations) or a hard
 * `maxWaitMs` ceiling. Used before snapshotting to avoid partial captures.
 */
export const waitForDomQuietPeriod = async (
    conversationId: string,
    platformName: string,
    quietMs: number,
    maxWaitMs: number,
): Promise<boolean> => {
    const root = (() => {
        try {
            return document.querySelector('main') ?? document.body;
        } catch {
            return document.body;
        }
    })();
    if (!root) {
        return true;
    }

    logger.info('Calibration snapshot quiet-wait start', {
        conversationId,
        platform: platformName,
        quietMs,
        maxWaitMs,
    });

    return new Promise((resolve) => {
        const startedAt = Date.now();
        let lastMutationAt = Date.now();
        let done = false;

        const finalize = (settled: boolean) => {
            if (done) {
                return;
            }
            done = true;
            observer.disconnect();
            clearInterval(intervalId);
            logger.info('Calibration snapshot quiet-wait result', {
                conversationId,
                platform: platformName,
                settled,
                elapsedMs: Date.now() - startedAt,
            });
            resolve(settled);
        };

        const observer = new MutationObserver(() => {
            lastMutationAt = Date.now();
        });
        observer.observe(root, { childList: true, subtree: true, characterData: true });

        const intervalId = window.setInterval(() => {
            const now = Date.now();
            if (now - lastMutationAt >= quietMs) {
                finalize(true);
            } else if (now - startedAt >= maxWaitMs) {
                finalize(false);
            }
        }, 250);
    });
};

const ingestCalibrationRawSnapshot = (
    conversationId: string,
    mode: CalibrationMode,
    snapshot: RawCaptureSnapshot,
    deps: CalibrationCaptureDeps,
) => {
    const replayUrls = deps.getRawSnapshotReplayUrls(conversationId, snapshot);
    logger.info('Calibration using raw capture snapshot', {
        conversationId,
        platform: deps.adapter.name,
        replayCandidates: replayUrls.length,
    });
    for (const replayUrl of replayUrls) {
        deps.ingestInterceptedData({
            url: replayUrl,
            data: snapshot.data,
            platform: snapshot.platform ?? deps.adapter.name,
        });
        if (deps.isCaptureSatisfied(conversationId, mode)) {
            logger.info('Calibration raw snapshot replay captured', {
                conversationId,
                platform: deps.adapter.name,
                replayUrl,
            });
            break;
        }
    }
};

const ingestEffectiveSnapshot = (
    conversationId: string,
    mode: CalibrationMode,
    effectiveSnapshot: unknown,
    deps: CalibrationCaptureDeps,
) => {
    try {
        if (isConversationDataLike(effectiveSnapshot)) {
            deps.ingestConversationData(effectiveSnapshot, 'calibration-snapshot');
            return;
        }
        if (isRawCaptureSnapshot(effectiveSnapshot)) {
            ingestCalibrationRawSnapshot(conversationId, mode, effectiveSnapshot, deps);
            return;
        }
        deps.ingestInterceptedData({
            url: `page-snapshot://${deps.adapter.name}/${conversationId}`,
            data: JSON.stringify(effectiveSnapshot),
            platform: deps.adapter.name,
        });
    } catch {
        // Swallow ingestion errors; caller checks cache directly.
    }
};

/**
 * Executes the `page-snapshot` calibration step. Requests a snapshot from the
 * MAIN world and falls back to an isolated DOM snapshot if unavailable. After
 * ingestion it tries a secondary isolated snapshot when a raw replay fails.
 */
export const captureFromSnapshot = async (
    conversationId: string,
    mode: CalibrationMode,
    deps: CalibrationCaptureDeps,
): Promise<boolean> => {
    // For auto-mode Gemini and ChatGPT, wait for DOM to settle first.
    if (mode === 'auto' && (deps.adapter.name === 'Gemini' || deps.adapter.name === 'ChatGPT')) {
        const settled = await waitForDomQuietPeriod(conversationId, deps.adapter.name, 1400, 20_000);
        if (!settled) {
            logger.info('Calibration snapshot deferred; DOM still active', {
                conversationId,
                platform: deps.adapter.name,
                mode,
            });
            return false;
        }
    }

    logger.info('Calibration snapshot fallback requested', { conversationId });
    const snapshot = await deps.requestSnapshot(conversationId);
    const isolatedSnapshot = snapshot ? null : deps.buildIsolatedSnapshot(conversationId);
    const effectiveSnapshot = snapshot ?? isolatedSnapshot;

    logger.info('Calibration snapshot fallback response', {
        conversationId,
        hasSnapshot: !!effectiveSnapshot,
        source: snapshot ? 'main-world' : isolatedSnapshot ? 'isolated-dom' : 'none',
    });

    if (!effectiveSnapshot) {
        return false;
    }

    ingestEffectiveSnapshot(conversationId, mode, effectiveSnapshot, deps);

    // If raw replay didn't capture, try isolated DOM as secondary fallback.
    if (!deps.isCaptureSatisfied(conversationId, mode) && isRawCaptureSnapshot(effectiveSnapshot)) {
        logger.info('Calibration snapshot replay did not capture conversation', {
            conversationId,
            platform: deps.adapter.name,
            replayUrl: effectiveSnapshot.url,
        });
        const isolated = isolatedSnapshot ?? deps.buildIsolatedSnapshot(conversationId);
        if (isolated) {
            logger.info('Calibration isolated DOM fallback after replay failure', {
                conversationId,
                platform: deps.adapter.name,
            });
            deps.ingestConversationData(isolated, 'calibration-isolated-dom-fallback');
        }
    }

    return deps.isCaptureSatisfied(conversationId, mode);
};

// ---------------------------------------------------------------------------
// endpoint-retry
// ---------------------------------------------------------------------------

const tryCalibrationFetch = async (
    conversationId: string,
    apiUrl: string,
    attempt: number,
    mode: CalibrationMode,
    deps: CalibrationCaptureDeps,
): Promise<boolean> => {
    try {
        const response = await fetch(apiUrl, { credentials: 'include' });
        logger.info('Calibration fetch response', {
            attempt,
            conversationId,
            ok: response.ok,
            status: response.status,
        });
        if (!response.ok) {
            return false;
        }
        const text = await response.text();
        deps.ingestInterceptedData({ url: apiUrl, data: text, platform: deps.adapter.name });
        return deps.isCaptureSatisfied(conversationId, mode);
    } catch (error) {
        logger.error('Calibration fetch error', error);
        return false;
    }
};

const CALIBRATION_RETRY_BACKOFF_MS = [0, 1500, 3000, 5000, 8000, 12_000];

/**
 * Retries all fetch URL candidates across a fixed backoff schedule.
 */
export const captureFromRetries = async (
    conversationId: string,
    mode: CalibrationMode,
    deps: CalibrationCaptureDeps,
): Promise<boolean> => {
    const urls = deps.getFetchUrlCandidates(conversationId);
    if (urls.length === 0) {
        logger.info('Calibration retries skipped: no fetch URL candidates', {
            conversationId,
            platform: deps.adapter.name,
        });
        return false;
    }

    for (let attempt = 0; attempt < CALIBRATION_RETRY_BACKOFF_MS.length; attempt++) {
        const waitMs = CALIBRATION_RETRY_BACKOFF_MS[attempt];
        if (waitMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        for (const apiUrl of urls) {
            if (await tryCalibrationFetch(conversationId, apiUrl, attempt + 1, mode, deps)) {
                return true;
            }
        }
    }
    return false;
};

// ---------------------------------------------------------------------------
// Composite step dispatcher
// ---------------------------------------------------------------------------

/**
 * Executes a single calibration step and returns `true` if the capture
 * is satisfied afterwards. Caller is responsible for iterating steps in order.
 */
export const runCalibrationStep = async (
    step: CalibrationStep,
    conversationId: string,
    mode: CalibrationMode,
    deps: CalibrationCaptureDeps,
): Promise<boolean> => {
    switch (step) {
        case 'queue-flush':
            deps.flushQueuedMessages();
            return deps.isCaptureSatisfied(conversationId, mode);
        case 'passive-wait':
            return waitForPassiveCapture(conversationId, mode, deps);
        case 'endpoint-retry':
            return captureFromRetries(conversationId, mode, deps);
        case 'page-snapshot':
            return captureFromSnapshot(conversationId, mode, deps);
        default:
            return false;
    }
};
