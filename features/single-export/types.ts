/**
 * Public types for the v3 single-export (on-demand Save JSON) kernel.
 *
 * The service is dependency-injected and returns a typed fail-fast result so
 * callers can pattern-match on `kind`. It never throws on the failure paths
 * that are part of the contract; the only unexpected throws should be from
 * bugs in the injected dependencies.
 *
 * @module features/single-export/types
 */

import type { LLMPlatform } from '@/platforms/types';
import type { GeminiBatchexecuteContext } from '@/utils/gemini-batchexecute-context';
import type { HeaderRecord } from '@/utils/proactive-fetch-headers';
import type { ConversationData } from '@/utils/types';

/**
 * Discriminated fail-fast error union for the single-export kernel.
 *
 * Each variant is an exact, typed failure that callers can switch on without
 * parsing free-form messages. No silent coercion or time-based retries.
 */
export type SingleExportError =
    | { kind: 'unsupported_platform'; platformName: string | null }
    | { kind: 'missing_conversation_id'; pageUrl: string }
    | { kind: 'missing_endpoint'; platformName: string }
    | { kind: 'missing_auth'; platformName: string }
    | { kind: 'http_failure'; platformName: string; status: number; statusText: string }
    | { kind: 'download_failure'; platformName: string; reason: string }
    | { kind: 'timeout'; platformName: string; timeoutMs: number }
    | { kind: 'parse_failure'; platformName: string; reason: string }
    | { kind: 'id_mismatch'; platformName: string; expected: string; actual: string | null }
    | { kind: 'not_terminal'; platformName: string; reason: string };

/**
 * Successful result: the validated, terminal conversation plus the filename
 * the kernel passed to the injected downloader.
 */
export type SingleExportSuccess = {
    kind: 'success';
    platformName: string;
    data: ConversationData;
    filename: string;
    jsonString: string;
};

/**
 * The discriminated union returned by the single-export kernel.
 */
export type SingleExportResult =
    | ({ kind: 'success' } & SingleExportSuccess)
    | { kind: 'failure'; error: SingleExportError };

/**
 * Optional, injectable logger. Defaults to the no-op-friendly logger.
 */
export type SingleExportLogger = {
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
    debug: (message: string, ...args: unknown[]) => void;
};

/**
 * The dependency surface for the v3 single-export kernel.
 *
 * Everything that touches the page, the network, or the DOM is injected so
 * the service can be unit-tested with deterministic fakes.
 */
export type SingleExportDeps = {
    /** Resolves the platform adapter for the supplied URL. Called only at click time. */
    resolveAdapter: (pageUrl: string) => LLMPlatform | null;
    /** Returns the current page URL. Called only at click time. */
    getPageUrl: () => string;
    /**
     * Returns optional platform auth headers captured from the page. Some
     * platforms (e.g. ChatGPT with __Secure-next-authdata) require them.
     * May be omitted when cookies alone are sufficient.
     */
    getAuthHeaders?: () => HeaderRecord | undefined;
    /**
     * Returns the Gemini batchexecute context (at/bl/f.sid/hl/reqid/rt)
     * captured from the page. Required to make a Gemini detail POST.
     */
    getGeminiBatchexecuteContext?: () => GeminiBatchexecuteContext | undefined;
    /** Invalidates the provider's captured request context after a 401/403 response. */
    invalidateAuthContext?: (platformName: string) => void;
    /** The fetch implementation. Defaults to the global `fetch`. */
    fetchImpl?: typeof fetch;
    /** The download function invoked with the serialized JSON. Required. */
    downloadJson: (jsonString: string, filename: string) => void;
    /** Wall-clock source for the timeout guard. Defaults to `Date.now`. */
    now?: () => number;
    /** Structured logger. Defaults to no-op-friendly logger. */
    logger?: SingleExportLogger;
};

/**
 * Per-call options for the single-export kernel.
 */
export type SingleExportOptions = {
    /** Hard timeout in milliseconds for the network round trip. */
    timeoutMs: number;
};

export const SINGLE_EXPORT_DEFAULT_TIMEOUT_MS = 15_000;
export const SINGLE_EXPORT_MIN_TIMEOUT_MS = 1000;
export const SINGLE_EXPORT_MAX_TIMEOUT_MS = 60_000;

export const normalizeSingleExportTimeout = (value: number | undefined, fallback: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return Math.min(SINGLE_EXPORT_MAX_TIMEOUT_MS, Math.max(SINGLE_EXPORT_MIN_TIMEOUT_MS, Math.floor(value)));
};
