import { extractBalancedJsonArray } from './json-parser';
import { stripMagicHeader } from './text-utils';

export type BatchexecuteResult = {
    rpcId: string;
    payload: string | null; // Payload might be null or string
};

/**
 * Parses a Google Batchexecute response string.
 * Handles extracting the JSON from the magic header and unwrapping the RPC envelope.
 *
 * @param text - Raw response text
 * @returns Array of parsed RPC results
 */
export function parseBatchexecuteResponse(text: string) {
    const cleanText = stripMagicHeader(text);

    // Extract the outer JSON array
    // We use the robust extractor because there might be trailing data or garbage
    const outerJson = extractBalancedJsonArray(cleanText);
    if (!outerJson) {
        return [];
    }

    let parsed: any[];
    try {
        parsed = JSON.parse(outerJson);
    } catch {
        return [];
    }

    if (!Array.isArray(parsed)) {
        return [];
    }

    return processOuterArray(parsed);
}

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
 * Supports both Gemini-style flat structure and generic nested structure.
 */
function processWrbFrItem(item: any[]): BatchexecuteResult[] {
    // Structure A (Gemini): ["wrb.fr", "RPC_ID", "PAYLOAD_JSON_STRING", ...]
    const [, rpcId, payload] = item;
    if (typeof rpcId === 'string' && typeof payload === 'string') {
        return [{ rpcId, payload }];
    }

    // Structure B (Nested): ["wrb.fr", "INNER_JSON_STRING", null, ...]
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
