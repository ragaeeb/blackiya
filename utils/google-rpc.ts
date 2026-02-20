import { extractBalancedJsonArray } from './json-parser';
import { stripMagicHeader } from './text-utils';

export type BatchexecuteResult = {
    rpcId: string;
    payload: string | null; // Payload might be null or string
};

/**
 * Parses a Google Batchexecute response string.
 * Handles both single-array responses (legacy batchexecute) and multi-chunk
 * length-prefixed responses (Gemini 3.0 StreamGenerate).
 *
 * @param text - Raw response text
 * @returns Array of parsed RPC results
 */
export const parseBatchexecuteResponse = (text: string) => {
    const cleanText = stripMagicHeader(text);
    const results: BatchexecuteResult[] = [];
    let searchFrom = 0;

    while (searchFrom < cleanText.length) {
        const startBracket = cleanText.indexOf('[', searchFrom);
        if (startBracket === -1) {
            break;
        }

        const outerJson = extractBalancedJsonArray(cleanText, startBracket);
        if (!outerJson) {
            // Malformed chunk: skip this bracket and continue scanning.
            searchFrom = startBracket + 1;
            continue;
        }

        // Advance past the extracted array for the next iteration
        searchFrom = startBracket + outerJson.length;

        try {
            const parsed = JSON.parse(outerJson);
            if (Array.isArray(parsed)) {
                results.push(...processOuterArray(parsed));
            }
        } catch {
            // Skip unparseable chunks
        }
    }

    return results;
};

/**
 * Processes the parsed outer array of a Batchexecute response.
 * Handles both standard wrappers and nested envelopes.
 */
function processOuterArray(parsedArray: any[]) {
    return parsedArray.flatMap((item): BatchexecuteResult | BatchexecuteResult[] => {
        if (!Array.isArray(item) || item.length < 1) {
            return [];
        }

        const [key, payload] = item;

        // Standard Batchexecute wrapper "wrb.fr"
        if (key === 'wrb.fr') {
            return processWrbFrItem(item);
        }

        // Direct RPC call fallback: [ "rpcId", "payload", ... ]
        if (typeof key === 'string' && item.length >= 2) {
            return { rpcId: key, payload };
        }

        return [];
    });
}

/**
 * Processes a 'wrb.fr' wrapper item.
 * Supports Gemini batchexecute, StreamGenerate (null rpcId), and nested structures.
 */
function processWrbFrItem(item: any[]): BatchexecuteResult[] {
    const [, rpcId, payload] = item;

    // Structure A (Gemini batchexecute): ["wrb.fr", "RPC_ID", "PAYLOAD_JSON_STRING", ...]
    if (typeof rpcId === 'string' && typeof payload === 'string') {
        return [{ rpcId, payload }];
    }

    // Structure B (Gemini StreamGenerate): ["wrb.fr", null, "PAYLOAD_JSON_STRING", ...]
    // Gemini 3.0 omits the RPC ID; assign a synthetic one so downstream consumers can identify it
    if (rpcId === null && typeof payload === 'string') {
        return [{ rpcId: '__stream__', payload }];
    }

    // Structure C (Nested): ["wrb.fr", "INNER_JSON_STRING", null, ...]
    if (typeof rpcId === 'string') {
        try {
            const innerParsed = JSON.parse(rpcId);
            if (Array.isArray(innerParsed)) {
                return innerParsed
                    .filter((rpc): rpc is [string, string, ...any[]] => Array.isArray(rpc) && rpc.length >= 2)
                    .map(([id, p]) => ({ rpcId: id, payload: p }));
            }
        } catch {
            // Ignore parse errors
        }
    }

    return [];
}
