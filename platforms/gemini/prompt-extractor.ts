/**
 * Gemini Prompt Extractor
 *
 * Extracts the user's prompt text from the XHR POST body sent to the
 * StreamGenerate endpoint. The body is URL-form-encoded with a `f.req`
 * field whose value is a doubly-JSON-encoded batchexecute payload.
 *
 * Structure (simplified):
 *   f.req = JSON.stringify([
 *     null,          // [0] metadata
 *     null,          // [1] continuation token (may be null on first turn)
 *     [              // [2] user turn slot
 *       [            // [2][0]
 *         [          // [2][0][0]
 *           "<user_prompt_text>",  ← the text we want
 *           ...
 *         ]
 *       ]
 *     ],
 *     ...
 *   ])
 *
 * Because the shape can drift across Gemini versions, we use a heuristic
 * depth-first search for the first string at index [2][0][0][0] of the
 * decoded payload, falling back to a generic deep-string scan bounded by
 * a minimum length to avoid matching noise like IDs and tokens.
 *
 * @module platforms/gemini/prompt-extractor
 */

import { logger } from '@/utils/logger';

const MIN_PROMPT_LENGTH = 3;
const MAX_SEARCH_DEPTH = 6;

/** Attempt to decode the `f.req` URL-encoded form body. */
const decodeFReqBody = (body: string): unknown => {
    try {
        // Body is application/x-www-form-urlencoded: "f.req=<encoded>&..."
        const params = new URLSearchParams(body);
        const fReq = params.get('f.req');
        if (!fReq) {
            return null;
        }
        return JSON.parse(fReq);
    } catch {
        return null;
    }
};

/**
 * Targeted extraction following the known batchexecute slot layout:
 * payload[2][0][0][0] is where the user text lives in the StreamGenerate body.
 */
const extractAtKnownPath = (payload: unknown): string | null => {
    if (!Array.isArray(payload)) {
        return null;
    }
    const slot2 = payload[2];
    if (!Array.isArray(slot2)) {
        return null;
    }
    const slot20 = slot2[0];
    if (!Array.isArray(slot20)) {
        return null;
    }
    const slot200 = slot20[0];
    if (!Array.isArray(slot200)) {
        return null;
    }
    const candidate = slot200[0];
    if (typeof candidate === 'string' && candidate.trim().length >= MIN_PROMPT_LENGTH) {
        return candidate.trim();
    }
    return null;
};

/**
 * Fallback: depth-first search for the first string value ≥ MIN_PROMPT_LENGTH
 * characters, bounded by MAX_SEARCH_DEPTH to avoid scanning the full payload.
 */
const findFirstSubstantialString = (node: unknown, depth: number): string | null => {
    if (depth > MAX_SEARCH_DEPTH) {
        return null;
    }
    if (typeof node === 'string') {
        const trimmed = node.trim();
        return trimmed.length >= MIN_PROMPT_LENGTH ? trimmed : null;
    }
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = findFirstSubstantialString(child, depth + 1);
            if (found) {
                return found;
            }
        }
    }
    return null;
};

/**
 * Extracts the user prompt from a Gemini StreamGenerate XHR POST body.
 *
 * Returns `null` if the body cannot be parsed or contains no usable text.
 */
export const extractGeminiPromptFromXhrBody = (body: string | null | undefined): string | null => {
    if (!body || typeof body !== 'string') {
        return null;
    }
    try {
        const payload = decodeFReqBody(body);
        if (!payload) {
            return null;
        }

        // Try the known slot path first
        const known = extractAtKnownPath(payload);
        if (known) {
            logger.debug('[Blackiya/Gemini] Extracted prompt from known slot path', { length: known.length });
            return known;
        }

        // Fallback: depth-bounded search
        const fallback = findFirstSubstantialString(payload, 0);
        if (fallback) {
            logger.debug('[Blackiya/Gemini] Extracted prompt via fallback scan', { length: fallback.length });
        }
        return fallback;
    } catch {
        return null;
    }
};
