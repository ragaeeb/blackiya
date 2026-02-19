import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('@/utils/logger', () => ({
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) },
}));

const STREAM_URL =
    'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';

const buildStreamResponse = (...chunks: string[]) => `)]}'\n\n` + chunks.map((c) => `${c.length}\n${c}\n`).join('');

const buildChunk = (payload: unknown) => JSON.stringify([['wrb.fr', null, JSON.stringify(payload), null]]);

describe('Gemini — StreamGenerate parsing (V2.1-031)', () => {
    let geminiAdapter: any;
    let resetGeminiAdapterState: () => void;

    beforeAll(async () => {
        const module = await import('@/platforms/gemini');
        geminiAdapter = module.geminiAdapter;
        resetGeminiAdapterState = module.resetGeminiAdapterState ?? (() => {});
    });

    beforeEach(() => resetGeminiAdapterState());

    it('should parse a multi-chunk response and return the last (richest) content', () => {
        const convId = 'stream_test_conv_001';
        const assistantText = 'This is the assistant response from StreamGenerate.';

        const metaPayload = [null, [null, 'r_resp1'], { '18': 'r_resp1' }];
        const earlyPayload = [null, [`c_${convId}`, 'r_resp1'], null, null, [['rc_cand1', [''], null]]];
        const fullPayload = [
            null,
            [`c_${convId}`, 'r_resp1'],
            null,
            null,
            [
                [
                    'rc_cand1',
                    [assistantText],
                    ...Array(33).fill(null),
                    null,
                    null,
                    null,
                    null,
                    ['Thinking step 1\n**Analysis**\nContent here'],
                ],
            ],
        ];

        const response = buildStreamResponse(
            buildChunk(metaPayload),
            buildChunk(earlyPayload),
            buildChunk(fullPayload),
        );

        const result = geminiAdapter.parseInterceptedData(response, STREAM_URL);
        expect(result).not.toBeNull();
        expect(result!.conversation_id).toBe(convId);

        const assistantMsg = Object.values(result!.mapping)
            .map((n: any) => n.message)
            .filter((m: any) => m !== null)
            .find((m: any) => m.author.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        expect(assistantMsg!.content.parts?.[0]).toBe(assistantText);
    });

    it('should extract conversation ID even when user message is absent', () => {
        const convId = 'stream_test_conv_002';
        const payload = [null, [`c_${convId}`, 'r_resp2'], null, null, [['rc_cand2', ['Reply'], null]]];

        const result = geminiAdapter.parseInterceptedData(buildStreamResponse(buildChunk(payload)), STREAM_URL);
        expect(result).not.toBeNull();
        expect(result?.conversation_id).toBe(convId);
    });

    it('should prefer the LAST chunk (richest content) over earlier partial chunks', () => {
        const convId = 'stream_test_conv_003';
        const earlyPayload = [null, [`c_${convId}`, 'r_resp3'], null, null, [['rc_cand3', ['Partial'], null]]];
        const fullPayload = [
            null,
            [`c_${convId}`, 'r_resp3'],
            null,
            null,
            [['rc_cand3', ['Complete final answer here'], null]],
        ];

        const response = buildStreamResponse(buildChunk(earlyPayload), buildChunk(fullPayload));
        const result = geminiAdapter.parseInterceptedData(response, STREAM_URL);

        expect(result).not.toBeNull();
        const assistantMsg = Object.values(result!.mapping)
            .map((n: any) => n.message)
            .filter((m: any) => m !== null)
            .find((m: any) => m.author.role === 'assistant');
        expect(assistantMsg?.content.parts?.[0]).toBe('Complete final answer here');
    });

    it('should extract thinking/reasoning sections from StreamGenerate chunks', () => {
        const convId = 'stream_test_conv_004';
        const thinkingText =
            '\n**Analyzing the Problem**\nI need to figure this out.\n**Developing Solution**\nHere is the approach.';

        const payload = [
            null,
            [`c_${convId}`, 'r_resp4'],
            null,
            null,
            [
                [
                    'rc_cand4',
                    ['Final answer text'],
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    [1],
                    'en',
                    null,
                    null,
                    [null, null, null, null, null, null, [0], []],
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    [false],
                    null,
                    false,
                    [],
                    null,
                    null,
                    null,
                    [],
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    [[thinkingText]],
                ],
            ],
        ];

        const result = geminiAdapter.parseInterceptedData(buildStreamResponse(buildChunk(payload)), STREAM_URL);
        expect(result).not.toBeNull();

        const assistantMsg = Object.values(result!.mapping)
            .map((n: any) => n.message)
            .filter((m: any) => m !== null)
            .find((m: any) => m.author.role === 'assistant');
        expect(assistantMsg?.content.thoughts).toBeDefined();
        expect(assistantMsg?.content.thoughts?.length).toBe(2);
        expect(assistantMsg?.content.thoughts?.[0].summary).toBe('Analyzing the Problem');
    });

    it('should parse StreamGenerate payload when envelope indices are shifted', () => {
        const convId = 'stream_test_conv_shifted_005';
        const shiftedPayload = [
            'metadata',
            null,
            [`c_${convId}`, 'r_resp5'],
            null,
            null,
            [['rc_cand5', ['Shifted envelope final answer'], null]],
        ];

        const chunk = JSON.stringify([['wrb.fr', null, JSON.stringify(shiftedPayload), null]]);
        const response = buildStreamResponse(chunk);
        const result = geminiAdapter.parseInterceptedData(response, STREAM_URL);

        expect(result).not.toBeNull();
        expect(result?.conversation_id).toBe(convId);
        const assistantMsg = Object.values(result!.mapping)
            .map((n: any) => n.message)
            .filter((m: any) => m !== null)
            .find((m: any) => m.author.role === 'assistant');
        expect(assistantMsg?.content.parts?.[0]).toBe('Shifted envelope final answer');
    });
});
