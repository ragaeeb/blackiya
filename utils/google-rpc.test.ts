import { describe, expect, it } from 'bun:test';
import { GOOGLE_SECURITY_PREFIX } from '../platforms/constants';
import { parseBatchexecuteResponse } from './google-rpc';

describe('Google RPC Parser', () => {
    it('should return empty array for empty input', () => {
        expect(parseBatchexecuteResponse('')).toEqual([]);
    });

    it('should ignore magic security header', () => {
        const start = GOOGLE_SECURITY_PREFIX;
        const json = JSON.stringify([['rpc1', 'payload1', null, '1']]);
        expect(parseBatchexecuteResponse(start + json)).toHaveLength(1);
    });

    it('should extract valid RPC entries', () => {
        // Note: The structure of batchexecute response is essentially a double-encoded string sometimes.
        // Usually: )]}' \n\n [["wrb.fr", "BIG_JSON_STRING", ...]]
        // And BIG_JSON_STRING parses to: [[["rpcId", "payload_str", ...], ...]]

        // Let's mock a simpler valid structure often seen after the initial outer envelope is peeled:
        // Actually, usually we get a raw string, we strip header, parse JSON.
        // The JSON is an array. Inside, we might have "wrb.fr" wrapper OR just the RPC array directly depending on endpoint.
        // But commonly: `)]}'\n\n[ ["wrb.fr", "[[[\"MaZiqc\",\"[...]\"]]]" ] ]`

        // However, the current gemini.ts implementation logic suggests:
        // 1. Strip )]}'
        // 2. Extract balanced JSON (finding the outer [ ... ])
        // 3. Parse that JSON.
        // 4. Iterate over items. If item[0] === 'wrb.fr', parse item[1] (which is the inner json string).
        // 5. That inner JSON is an array of RPC calls: [ ["rpcId", "payload", ...] ]

        const innerPayload = JSON.stringify([
            ['rpc1', '{"data":1}', null, '1'],
            ['rpc2', '{"data":2}', null, '2'],
        ]);
        const outerPayload = JSON.stringify([
            ['wrb.fr', innerPayload, null, null, null, null, null, null, null, null, null, 2],
        ]);

        const input = GOOGLE_SECURITY_PREFIX + outerPayload;

        // Gemini often uses: ['wrb.fr', 'RPC_ID', 'PAYLOAD_STRING', ...]
        const geminiStyle = JSON.stringify([['wrb.fr', 'MaZiqc', '{"title":"New Chat"}', null, null]]);
        const input2 = GOOGLE_SECURITY_PREFIX + geminiStyle;
        const result2 = parseBatchexecuteResponse(input2);
        expect(result2).toHaveLength(1);
        expect(result2[0]).toEqual({ rpcId: 'MaZiqc', payload: '{"title":"New Chat"}' });

        const result = parseBatchexecuteResponse(input);
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ rpcId: 'rpc1', payload: '{"data":1}' });
        expect(result[1]).toEqual({ rpcId: 'rpc2', payload: '{"data":2}' });
    });
});
