import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as commonExport from '@/utils/common-export';
import { buildLoggerMock, createLoggerCalls } from '@/utils/runner/__tests__/helpers';
import {
    attachExportMeta,
    buildExportPayloadForFormat,
    extractResponseTextFromConversation,
} from '@/utils/runner/export-helpers';
import type { ExportMeta } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

const logCalls = createLoggerCalls();
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));

mock.module('@/utils/common-export', () => ({
    buildCommonExport: mock((data, platform) => {
        if (data.title === 'throw') {
            throw new Error('Test error');
        }
        return {
            response: data.title === 'response' ? 'some response' : null,
            prompt: data.title === 'prompt' ? 'some prompt' : null,
        };
    }),
}));

describe('export-helpers', () => {
    beforeEach(() => {
        logCalls.debug.length = 0;
        logCalls.info.length = 0;
        logCalls.warn.length = 0;
        logCalls.error.length = 0;
        (commonExport.buildCommonExport as ReturnType<typeof mock>).mockClear();
    });

    describe('buildExportPayloadForFormat', () => {
        it('should return raw data if format is not common', () => {
            const data = { title: 'test' } as ConversationData;
            expect(buildExportPayloadForFormat(data, 'original', 'ChatGPT')).toBe(data);
        });

        it('should build common export if format is common', () => {
            const data = { title: 'response' } as ConversationData;
            const result = buildExportPayloadForFormat(data, 'common', 'ChatGPT');
            expect(result).toEqual({ response: 'some response', prompt: null });
        });

        it('should capture error and fallback to raw data if buildCommonExport throws', () => {
            const data = { title: 'throw' } as ConversationData;
            const result = buildExportPayloadForFormat(data, 'common', 'ChatGPT');
            expect(result).toBe(data);
            expect(logCalls.error).toHaveLength(1);
        });
    });

    describe('attachExportMeta', () => {
        const meta: ExportMeta = { captureSource: 'canonical_api', fidelity: 'high', completeness: 'complete' };

        it('should return payload unchanged if not an object or array', () => {
            expect(attachExportMeta(null, meta)).toBeNull();
            expect(attachExportMeta('string', meta)).toBe('string');
            expect(attachExportMeta([], meta)).toEqual([]);
        });

        it('should attach meta deeply to a plain object', () => {
            const payload = { some: 'data' };
            const result = attachExportMeta(payload, meta) as any;
            expect(result.__blackiya.exportMeta).toEqual(meta);
            expect(result.some).toBe('data');
        });

        it('should merge with existing __blackiya object', () => {
            const payload = { __blackiya: { oldMeta: 1 } };
            const result = attachExportMeta(payload, meta) as any;
            expect(result.__blackiya.exportMeta).toEqual(meta);
            expect(result.__blackiya.oldMeta).toBe(1);
        });
    });

    describe('extractResponseTextFromConversation', () => {
        it('should return response text from common export', () => {
            const data = { title: 'response', mapping: {} } as ConversationData;
            expect(extractResponseTextFromConversation(data, 'ChatGPT')).toBe('some response');
        });

        it('should return prompt info if no response but prompt exists', () => {
            const data = { title: 'prompt', mapping: {} } as ConversationData;
            expect(extractResponseTextFromConversation(data, 'ChatGPT')).toContain('some prompt');
        });

        it('should fallback to raw message extraction if common export fails', () => {
            const data = {
                title: 'throw',
                mapping: {
                    node1: { message: { author: { role: 'assistant' }, content: { parts: ['first'] } } },
                    node2: { message: { author: { role: 'user' }, content: { parts: ['ignored'] } } },
                    node3: { message: { author: { role: 'assistant' }, content: { parts: ['second'] } } },
                },
            } as any as ConversationData;

            expect(extractResponseTextFromConversation(data, 'ChatGPT')).toBe('first\n\nsecond');
        });
    });
});
