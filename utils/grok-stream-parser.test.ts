import { describe, expect, it } from 'bun:test';

import { extractGrokStreamSignalsFromBuffer } from '@/utils/grok-stream-parser';

describe('grok-stream-parser', () => {
    it('should extract conversation id and text from NDJSON lines', () => {
        const seenPayloads = new Set<string>();
        const buffer = [
            JSON.stringify({ conversationId: '40b7c6bb-120d-4cf9-951a-0ae33345d07c', message: 'First chunk' }),
            JSON.stringify({ result: { response: { modelResponse: { message: 'Second chunk' } } } }),
            '',
        ].join('\n');

        const signals = extractGrokStreamSignalsFromBuffer(buffer, seenPayloads);

        expect(signals.conversationId).toBe('40b7c6bb-120d-4cf9-951a-0ae33345d07c');
        expect(signals.textCandidates).toEqual(['First chunk', 'Second chunk']);
        expect(signals.reasoningCandidates).toEqual([]);
        expect(signals.remainingBuffer).toBe('');
        expect(signals.seenPayloadKeys.length).toBe(2);
    });

    it('should extract reasoning candidates from deepsearch headers and thinking trace', () => {
        const seenPayloads = new Set<string>();
        const buffer = `${JSON.stringify({
            result: {
                response: {
                    modelResponse: {
                        message: 'Final answer',
                        thinking_trace: 'Check the premise first',
                        deepsearch_headers: [
                            {
                                header: 'Reasoning',
                                steps: [{ final_message: 'Collect candidate evidence.' }],
                            },
                        ],
                    },
                },
            },
        })}\n`;

        const signals = extractGrokStreamSignalsFromBuffer(buffer, seenPayloads);

        expect(signals.textCandidates).toContain('Final answer');
        expect(signals.reasoningCandidates).toContain('Check the premise first');
        expect(signals.reasoningCandidates).toContain('Reasoning: Collect candidate evidence.');
    });

    it('should dedupe previously seen lines across calls', () => {
        const seenPayloads = new Set<string>();
        const buffer = `${JSON.stringify({ message: 'Only once' })}\n`;

        const first = extractGrokStreamSignalsFromBuffer(buffer, seenPayloads);
        const second = extractGrokStreamSignalsFromBuffer(buffer, seenPayloads);

        expect(first.textCandidates).toEqual(['Only once']);
        expect(second.textCandidates).toEqual([]);
        expect(second.reasoningCandidates).toEqual([]);
    });

    it('should preserve partial trailing buffer until complete line arrives', () => {
        const seenPayloads = new Set<string>();
        const firstChunk = `${JSON.stringify({ message: 'Complete line' })}\n{"message":"part`;

        const first = extractGrokStreamSignalsFromBuffer(firstChunk, seenPayloads);
        expect(first.textCandidates).toEqual(['Complete line']);
        expect(first.remainingBuffer).toBe('{"message":"part');

        const second = extractGrokStreamSignalsFromBuffer(`${first.remainingBuffer}ial"}\n`, seenPayloads);
        expect(second.textCandidates).toEqual(['partial']);
        expect(second.remainingBuffer).toBe('');
    });

    it('should extract conversation id from nested result envelope', () => {
        const seenPayloads = new Set<string>();
        const buffer = `${JSON.stringify({
            result: {
                conversation: {
                    conversationId: '6992adb8-6b80-8332-a2fb-c8d2b407b6bb',
                },
            },
        })}\n`;

        const signals = extractGrokStreamSignalsFromBuffer(buffer, seenPayloads);
        expect(signals.conversationId).toBe('6992adb8-6b80-8332-a2fb-c8d2b407b6bb');
    });

    it('should parse data-prefixed NDJSON lines safely', () => {
        const seenPayloads = new Set<string>();
        const buffer = `data: ${JSON.stringify({
            conversationId: '40b7c6bb-120d-4cf9-951a-0ae33345d07c',
            message: 'Data prefix line',
        })}\n`;

        const signals = extractGrokStreamSignalsFromBuffer(buffer, seenPayloads);
        expect(signals.conversationId).toBe('40b7c6bb-120d-4cf9-951a-0ae33345d07c');
        expect(signals.textCandidates).toEqual(['Data prefix line']);
    });

    it('should preserve boundary whitespace in text candidates for stream joins', () => {
        const seenPayloads = new Set<string>();
        const buffer = [JSON.stringify({ message: 'Word ' }), JSON.stringify({ message: 'continuation' }), ''].join(
            '\n',
        );

        const signals = extractGrokStreamSignalsFromBuffer(buffer, seenPayloads);
        expect(signals.textCandidates).toEqual(['Word ', 'continuation']);
    });

    it('should extract tool usage card thinking notes as reasoning candidates', () => {
        const seenPayloads = new Set<string>();
        const toolUsagePayload = [
            '<xai:tool_usage_card>',
            '<xai:tool_args><![CDATA[{"message":"I have the full text broken into segments P101391 to P101395a.","to":"Grok"}]]></xai:tool_args>',
            '</xai:tool_usage_card>',
        ].join('\n');
        const buffer = `${JSON.stringify({
            result: {
                response: {
                    token: toolUsagePayload,
                    isThinking: true,
                    messageTag: 'tool_usage_card',
                },
            },
        })}\n`;

        const signals = extractGrokStreamSignalsFromBuffer(buffer, seenPayloads);

        expect(signals.reasoningCandidates).toContain('I have the full text broken into segments P101391 to P101395a.');
        expect(signals.textCandidates).toEqual([]);
    });
});
