import { describe, expect, it } from 'bun:test';
import { extractGeminiStreamSignalsFromBuffer } from '@/utils/gemini-stream-parser';

describe('gemini-stream-parser', () => {
    it('should extract conversation id and text from batchexecute buffer', () => {
        const payload = JSON.stringify([
            null,
            ['c_abcd1234efgh5678', 'r_1'],
            null,
            null,
            [['Hello world from Gemini']],
        ]);
        const buffer = `)]}'\n150\n[["wrb.fr",null,${JSON.stringify(payload)},null,null,null,"generic"]]`;
        const seenPayloads = new Set<string>();

        const signals = extractGeminiStreamSignalsFromBuffer(buffer, seenPayloads);
        expect(signals.conversationId).toBe('abcd1234efgh5678');
        expect(signals.textCandidates).toContain('Hello world from Gemini');
    });

    it('should not re-emit text candidates for previously seen payloads', () => {
        const payload = JSON.stringify([null, ['c_ffff1111aaaa2222', 'r_1'], null, null, [['Incremental answer']]]);
        const buffer = `)]}'\n150\n[["wrb.fr",null,${JSON.stringify(payload)},null,null,null,"generic"]]`;
        const seenPayloads = new Set<string>();

        const first = extractGeminiStreamSignalsFromBuffer(buffer, seenPayloads);
        const second = extractGeminiStreamSignalsFromBuffer(buffer, seenPayloads);
        expect(first.textCandidates).toContain('Incremental answer');
        expect(second.textCandidates.length).toBe(0);
    });

    it('should filter metadata-like noise strings', () => {
        const payload = JSON.stringify([
            null,
            ['c_ffff1111aaaa2222', 'r_1'],
            null,
            null,
            [['2026-02-16T00:26:14.436Z', 'warmcentralus', 'Readable sentence candidate']],
        ]);
        const buffer = `)]}'\n170\n[["wrb.fr",null,${JSON.stringify(payload)},null,null,null,"generic"]]`;
        const seenPayloads = new Set<string>();

        const signals = extractGeminiStreamSignalsFromBuffer(buffer, seenPayloads);
        expect(signals.textCandidates).toContain('Readable sentence candidate');
        expect(signals.textCandidates.some((value) => value.includes('2026-02-16T00:26:14.436Z'))).toBe(false);
    });

    it('should extract title candidates from StreamGenerate metadata payloads', () => {
        const payload = JSON.stringify([
            null,
            ['c_d628c5373645e315', 'r_e474e3de4f4e8c85'],
            { '11': ['Tafsir of Prayer of Fear Verse'], '44': false },
        ]);
        const buffer = `)]}'\n150\n[["wrb.fr",null,${JSON.stringify(payload)},null,null,null,"generic"]]`;
        const seenPayloads = new Set<string>();

        const signals = extractGeminiStreamSignalsFromBuffer(buffer, seenPayloads);
        expect(signals.conversationId).toBe('d628c5373645e315');
        expect(signals.titleCandidates).toContain('Tafsir of Prayer of Fear Verse');
    });

    it('should ignore generic title candidates such as "Conversation with Gemini"', () => {
        const payload = JSON.stringify([
            null,
            ['c_d628c5373645e315', 'r_e474e3de4f4e8c85'],
            { '11': ['Conversation with Gemini'], '44': false },
        ]);
        const buffer = `)]}'\n150\n[["wrb.fr",null,${JSON.stringify(payload)},null,null,null,"generic"]]`;
        const seenPayloads = new Set<string>();

        const signals = extractGeminiStreamSignalsFromBuffer(buffer, seenPayloads);
        expect(signals.conversationId).toBe('d628c5373645e315');
        expect(signals.titleCandidates).not.toContain('Conversation with Gemini');
    });
});
