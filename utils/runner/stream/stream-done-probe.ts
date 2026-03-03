/**
 * Stream done probe — proactively fetches and verifies canonical conversation
 * data once the response stream ends. Respects cross-tab probe lease
 * arbitration to avoid duplicate network work. Falls back to page snapshots
 * when all API URL candidates fail.
 *
 * All dependencies are injected so the module is unit-testable in isolation.
 */

import { isConversationDataLike, isRawCaptureSnapshot } from '@/utils/runner/calibration-capture';
import type { ConversationData } from '@/utils/types';

// Types

export type StreamDoneProbeDeps = {
    /** Adapter / platform name for URL construction, logging, and ingestion. */
    platformName: string;
    /**
     * Parse raw intercepted response bytes into ConversationData.
     * Should return `null` for unrecognised or mismatched formats.
     */
    parseInterceptedData: (text: string, url: string) => ConversationData | null;
    /** Returns `true` when the attempt has been disposed or superseded. */
    isAttemptDisposedOrSuperseded: (attemptId: string) => boolean;
    /** Attempt to acquire the cross-tab probe lease. Returns `false` when blocked. */
    acquireProbeLease: (conversationId: string, attemptId: string) => Promise<boolean>;
    /** Release the cross-tab probe lease; called unconditionally in `finally`. */
    releaseProbeLease: (conversationId: string, attemptId: string) => Promise<void>;
    /** Cancel any existing in-flight probe registered for this attempt. */
    cancelExistingProbe: (attemptId: string) => void;
    /** Register the AbortController for the new probe so it can be cancelled. */
    registerProbeController: (attemptId: string, controller: AbortController) => void;
    /** Unregister the probe controller when the probe completes or fails. */
    unregisterProbeController: (attemptId: string) => void;
    /** Resolve (or create) the attempt ID for the given conversation. */
    resolveAttemptId: (conversationId: string) => string;
    /** Returns ordered fetch URL candidates for the conversation. */
    getFetchUrlCandidates: (conversationId: string) => string[];
    /** Returns Grok raw-snapshot replay URL candidates for a given snapshot. */
    getRawSnapshotReplayUrls: (conversationId: string, snapshot: { url: string }) => string[];
    /** Returns the cached ConversationData for a conversation, if any. */
    getConversation: (conversationId: string) => ConversationData | null;
    /** Evaluates readiness for a captured ConversationData. */
    evaluateReadiness: (data: ConversationData) => { ready: boolean };
    /** Ingest a parsed ConversationData into the interception cache. */
    ingestConversationData: (data: ConversationData, source: string) => void;
    /** Ingest raw intercepted bytes into the interception cache. */
    ingestInterceptedData: (args: { url: string; data: string; platform: string }) => void;
    /** Request a full page snapshot from the MAIN world interceptor. */
    requestSnapshot: (conversationId: string) => Promise<unknown | null>;
    /** Build a fallback snapshot from the isolated DOM (no MAIN world round-trip). */
    buildIsolatedSnapshot: (conversationId: string) => ConversationData | null;
    /** Extract human-readable response text for display in the probe panel. */
    extractResponseText: (data: ConversationData) => string;
    /**
     * Update the stream probe panel for the given conversation.
     * Implementations should preserve the live mirror snapshot in the body.
     */
    setStreamDonePanel: (conversationId: string, status: string, body: string) => void;
    /**
     * Called when this probe becomes the active probe for the conversation.
     * Used to suppress panel updates from probes that have been superseded.
     */
    onProbeActive: (probeKey: string, conversationId: string) => void;
    /** Returns `true` when the given probe key is still the active probe. */
    isProbeKeyActive: (probeKey: string) => boolean;
    /** General-purpose logger for info and warn messages. */
    emitLog: (level: 'info' | 'warn', message: string, payload?: Record<string, unknown>) => void;
};

type ProbeContext = {
    conversationId: string;
    attemptId: string;
    probeKey: string;
    controller: AbortController;
};

// Internal helpers

const createProbeContext = async (
    conversationId: string,
    hintedAttemptId: string | undefined,
    deps: StreamDoneProbeDeps,
): Promise<ProbeContext | null> => {
    const attemptId = hintedAttemptId ?? deps.resolveAttemptId(conversationId);
    if (deps.isAttemptDisposedOrSuperseded(attemptId)) {
        return null;
    }
    if (!(await deps.acquireProbeLease(conversationId, attemptId))) {
        return null;
    }
    deps.cancelExistingProbe(attemptId);
    const controller = new AbortController();
    deps.registerProbeController(attemptId, controller);
    return {
        conversationId,
        attemptId,
        probeKey: `${deps.platformName}:${conversationId}:${Date.now()}`,
        controller,
    };
};

/**
 * Ingests a snapshot payload — ConversationData, raw Grok snapshot, or unknown
 * JSON — into the interception cache using the appropriate ingestion path.
 */
const ingestSnapshotData = (
    conversationId: string,
    snapshot: ConversationData | unknown,
    deps: StreamDoneProbeDeps,
) => {
    if (isConversationDataLike(snapshot)) {
        deps.ingestConversationData(snapshot, 'stream-done-snapshot');
        return;
    }
    if (isRawCaptureSnapshot(snapshot)) {
        for (const replayUrl of deps.getRawSnapshotReplayUrls(conversationId, snapshot)) {
            deps.ingestInterceptedData({
                url: replayUrl,
                data: snapshot.data,
                platform: snapshot.platform ?? deps.platformName,
            });
            const cached = deps.getConversation(conversationId);
            if (cached && deps.evaluateReadiness(cached).ready) {
                break;
            }
        }
        return;
    }
    deps.ingestInterceptedData({
        url: `stream-snapshot://${deps.platformName}/${conversationId}`,
        data: JSON.stringify(snapshot),
        platform: deps.platformName,
    });
};

/**
 * Requests a snapshot from the MAIN world (or builds an isolated DOM snapshot
 * as fallback), ingests it, then returns `true` when the conversation is ready.
 */
const captureFromSnapshotFallback = async (
    conversationId: string,
    attemptId: string,
    deps: StreamDoneProbeDeps,
): Promise<boolean> => {
    if (deps.isAttemptDisposedOrSuperseded(attemptId)) {
        return false;
    }
    deps.emitLog('info', 'Stream done snapshot fallback requested', {
        platform: deps.platformName,
        conversationId,
    });
    const snapshot = await deps.requestSnapshot(conversationId);
    const fallback = snapshot ?? deps.buildIsolatedSnapshot(conversationId);
    if (!fallback) {
        return false;
    }
    try {
        ingestSnapshotData(conversationId, fallback, deps);
    } catch {
        return false;
    }
    const cached = deps.getConversation(conversationId);
    const captured = !!cached && deps.evaluateReadiness(cached).ready;
    if (captured) {
        deps.emitLog('info', 'Stream done snapshot fallback captured', {
            platform: deps.platformName,
            conversationId,
        });
    }
    return captured;
};

const handleNoCandidates = async (context: ProbeContext, deps: StreamDoneProbeDeps): Promise<void> => {
    const captured = await captureFromSnapshotFallback(context.conversationId, context.attemptId, deps);
    if (captured) {
        const cached = deps.getConversation(context.conversationId);
        const body = cached
            ? deps.extractResponseText(cached) || '(captured via snapshot fallback)'
            : '(captured via snapshot fallback)';
        deps.setStreamDonePanel(
            context.conversationId,
            'stream-done: degraded snapshot captured',
            `${body}\n\nAwaiting canonical capture. Force Save appears only if stabilization times out.`,
        );
        return;
    }
    deps.setStreamDonePanel(
        context.conversationId,
        'stream-done: no api url candidates',
        `conversationId=${context.conversationId}`,
    );
    deps.emitLog('warn', 'Stream done probe has no URL candidates', {
        platform: deps.platformName,
        conversationId: context.conversationId,
    });
};

/**
 * Iterates URL candidates, fetches each, and returns `true` on the first
 * successful canonical capture. Panel is updated only when this probe is
 * still the active one.
 */
const tryFetchCandidates = async (
    context: ProbeContext,
    apiUrls: string[],
    deps: StreamDoneProbeDeps,
): Promise<boolean> => {
    for (const apiUrl of apiUrls) {
        if (context.controller.signal.aborted || deps.isAttemptDisposedOrSuperseded(context.attemptId)) {
            return true;
        }
        try {
            const response = await fetch(apiUrl, {
                credentials: 'include',
                signal: context.controller.signal,
            });
            if (!response.ok) {
                continue;
            }
            const text = await response.text();
            const parsed = deps.parseInterceptedData(text, apiUrl);
            if (!parsed?.conversation_id || parsed.conversation_id !== context.conversationId) {
                continue;
            }
            const body = deps.extractResponseText(parsed) || '(empty response text)';
            if (deps.isProbeKeyActive(context.probeKey)) {
                deps.setStreamDonePanel(context.conversationId, 'stream-done: fetched full text', body);
            }
            deps.emitLog('info', 'Stream done probe success', {
                platform: deps.platformName,
                conversationId: context.conversationId,
                textLength: body.length,
            });
            return true;
        } catch {
            // try next candidate
        }
    }
    return false;
};

/**
 * Shown when all fetch candidates fail. Tries cache → snapshot → awaiting-capture
 * in priority order, updating the probe panel appropriately.
 */
const showFallbackPanel = async (context: ProbeContext, deps: StreamDoneProbeDeps): Promise<void> => {
    if (!deps.isProbeKeyActive(context.probeKey)) {
        return;
    }
    const cached = deps.getConversation(context.conversationId);
    if (cached && deps.evaluateReadiness(cached).ready) {
        const cachedText = deps.extractResponseText(cached);
        const body = cachedText.length > 0 ? cachedText : '(captured cache ready; no assistant text extracted)';
        deps.setStreamDonePanel(context.conversationId, 'stream-done: using captured cache', body);
        return;
    }
    const capturedFromSnapshot = await captureFromSnapshotFallback(context.conversationId, context.attemptId, deps);
    if (capturedFromSnapshot) {
        const snapshotCached = deps.getConversation(context.conversationId);
        const snapshotText = snapshotCached ? deps.extractResponseText(snapshotCached) : '';
        const snapshotBody = snapshotText.length > 0 ? snapshotText : '(captured via snapshot fallback)';
        deps.setStreamDonePanel(
            context.conversationId,
            'stream-done: degraded snapshot captured',
            `${snapshotBody}\n\nAwaiting canonical capture. Force Save appears only if stabilization times out.`,
        );
        return;
    }
    deps.setStreamDonePanel(
        context.conversationId,
        'stream-done: awaiting canonical capture',
        `Conversation stream completed for ${context.conversationId}. Waiting for canonical capture.`,
    );
};

// Public API

/**
 * Orchestrates the post-stream canonical capture probe for a conversation.
 *
 * Flow:
 * 1. Acquire cross-tab probe lease (retry scheduled externally on failure).
 * 2. Try platform API URL candidates via fetch.
 * 3. On failure, fall back to page snapshot or isolated DOM snapshot.
 * 4. Update the stream probe panel throughout with live status.
 */
export const runStreamDoneProbe = async (
    conversationId: string,
    hintedAttemptId: string | undefined,
    deps: StreamDoneProbeDeps,
): Promise<void> => {
    const context = await createProbeContext(conversationId, hintedAttemptId, deps);
    if (!context) {
        return;
    }
    try {
        deps.onProbeActive(context.probeKey, context.conversationId);
        deps.setStreamDonePanel(
            context.conversationId,
            'stream-done: fetching conversation',
            `conversationId=${context.conversationId}`,
        );
        deps.emitLog('info', 'Stream done probe start', {
            platform: deps.platformName,
            conversationId: context.conversationId,
        });
        const apiUrls = deps.getFetchUrlCandidates(context.conversationId);
        if (apiUrls.length === 0) {
            await handleNoCandidates(context, deps);
            return;
        }
        const succeeded = await tryFetchCandidates(context, apiUrls, deps);
        if (!succeeded) {
            await showFallbackPanel(context, deps);
            deps.emitLog('warn', 'Stream done probe failed', {
                platform: deps.platformName,
                conversationId: context.conversationId,
            });
        }
    } finally {
        deps.unregisterProbeController(context.attemptId);
        void deps.releaseProbeLease(context.conversationId, context.attemptId).catch((error) => {
            deps.emitLog('info', 'Probe lease release failed', {
                conversationId: context.conversationId,
                attemptId: context.attemptId,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }
};
