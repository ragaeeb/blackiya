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
        const innerPayload = JSON.stringify([
            ['rpc1', '{"data":1}', null, '1'],
            ['rpc2', '{"data":2}', null, '2'],
        ]);
        const outerPayload = JSON.stringify([
            ['wrb.fr', innerPayload, null, null, null, null, null, null, null, null, null, 2],
        ]);

        const input = GOOGLE_SECURITY_PREFIX + outerPayload;

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

    describe('Multi-chunk responses (StreamGenerate format — V2.1-025)', () => {
        it('should extract RPC results from ALL chunks in a length-prefixed response', () => {
            // StreamGenerate uses: )]}'  \n\n {len}\n[["wrb.fr",...]] \n {len}\n[["wrb.fr",...]]
            const chunk1 = JSON.stringify([['wrb.fr', 'RPC1', '{"data":"first"}', null]]);
            const chunk2 = JSON.stringify([['wrb.fr', 'RPC2', '{"data":"second"}', null]]);
            const input = `)]}'  \n\n${chunk1.length}\n${chunk1}\n${chunk2.length}\n${chunk2}\n`;
            const result = parseBatchexecuteResponse(input);
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({ rpcId: 'RPC1', payload: '{"data":"first"}' });
            expect(result[1]).toEqual({ rpcId: 'RPC2', payload: '{"data":"second"}' });
        });

        it('should handle null rpcId in wrb.fr wrapper (StreamGenerate)', () => {
            // Gemini 3.0 StreamGenerate format: ["wrb.fr", null, "PAYLOAD", ...]
            const json = JSON.stringify([['wrb.fr', null, '{"conversation":"data"}', null]]);
            const input = `)]}'  \n\n${json}`;
            const result = parseBatchexecuteResponse(input);
            expect(result).toHaveLength(1);
            expect(result[0].payload).toBe('{"conversation":"data"}');
            // rpcId should be a synthetic placeholder, not null
            expect(typeof result[0].rpcId).toBe('string');
        });

        it('should extract conversation payload from multi-chunk null-rpcId response', () => {
            // Realistic StreamGenerate: metadata chunk + conversation chunk
            const metaPayload =
                '[null,[null,"r_abc123"],null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,"r_abc123"]';
            const convPayload = '[null,["c_59f84576f1e364bb","r_abc123"],null,"conversation content"]';
            const chunk1 = JSON.stringify([['wrb.fr', null, metaPayload, null]]);
            const chunk2 = JSON.stringify([['wrb.fr', null, convPayload, null]]);
            const input = `)]}'  \n\n${chunk1.length}\n${chunk1}\n${chunk2.length}\n${chunk2}\n`;
            const result = parseBatchexecuteResponse(input);
            expect(result).toHaveLength(2);
            // Both should have valid payloads
            expect(result[0].payload).toBe(metaPayload);
            expect(result[1].payload).toBe(convPayload);
            // The conversation chunk payload should contain the conversation ID
            expect(result[1].payload).toContain('c_59f84576f1e364bb');
        });

        it('should parse array chunks even when prefixed with non-array noise', () => {
            const chunk1 = JSON.stringify([['wrb.fr', 'RPC1', '{"data":"first"}', null]]);
            const chunk2 = JSON.stringify([['wrb.fr', 'RPC2', '{"data":"second"}', null]]);
            const input = `)]}'\nxyz-prefix\n${chunk1.length}\n${chunk1}\nnotes\n${chunk2.length}\n${chunk2}\n`;
            const result = parseBatchexecuteResponse(input);
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({ rpcId: 'RPC1', payload: '{"data":"first"}' });
            expect(result[1]).toEqual({ rpcId: 'RPC2', payload: '{"data":"second"}' });
        });

        it('should continue scanning after malformed bracketed chunk and parse subsequent valid chunk', () => {
            const brokenPrefix = '[broken chunk without a closing bracket';
            const validChunk = JSON.stringify([['wrb.fr', 'RPC_OK', '{"ok":true}', null]]);
            const input = `)]}'\n${brokenPrefix}\nnoise\n${validChunk.length}\n${validChunk}\n`;
            const result = parseBatchexecuteResponse(input);
            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ rpcId: 'RPC_OK', payload: '{"ok":true}' });
        });
    });
});
