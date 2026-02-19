import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { join } from 'node:path';

import type { Message, MessageNode } from '@/utils/types';

const loggerSpies = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
};

mock.module('@/utils/logger', () => ({ logger: loggerSpies }));

describe('Gemini Adapter — integration', () => {
    let conversationResponseRaw: string;
    let titlesResponseRaw: string;
    let geminiAdapter: any;
    let resetGeminiAdapterState: () => void;

    beforeAll(async () => {
        const module = await import('@/platforms/gemini');
        geminiAdapter = module.geminiAdapter;
        resetGeminiAdapterState = module.resetGeminiAdapterState ?? (() => {});

        conversationResponseRaw = await Bun.file(
            join(import.meta.dir, '..', '..', 'data', 'gemini', 'sample_gemini_conversation.txt'),
        ).text();
        titlesResponseRaw = await Bun.file(
            join(import.meta.dir, '..', '..', 'data', 'gemini', 'sample_gemini_titles.txt'),
        ).text();
    });

    beforeEach(() => {
        resetGeminiAdapterState();
        for (const spy of Object.values(loggerSpies)) {
            spy.mockClear();
        }
    });

    describe('URL handling', () => {
        it('should identify Gemini URLs', () => {
            expect(geminiAdapter.isPlatformUrl('https://gemini.google.com/app/12345')).toBeTrue();
            expect(geminiAdapter.isPlatformUrl('https://gemini.google.com/')).toBeTrue();
            expect(geminiAdapter.isPlatformUrl('https://google.com')).toBeFalse();
        });

        it('should extract conversation IDs from app and share URLs', () => {
            expect(geminiAdapter.extractConversationId('https://gemini.google.com/app/abcdef123')).toBe('abcdef123');
            expect(geminiAdapter.extractConversationId('https://gemini.google.com/share/shared_id_123')).toBe(
                'shared_id_123',
            );
            expect(geminiAdapter.extractConversationId('https://gemini.google.com')).toBeNull();
        });

        it('should return null when extracting conversation ID from Gemini API URL', () => {
            expect(
                geminiAdapter.extractConversationIdFromUrl(
                    'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb',
                ),
            ).toBeNull();
        });
    });

    describe('API pattern matching', () => {
        it('should match batchexecute URLs even when rpcids drift', () => {
            const pattern = geminiAdapter.apiEndpointPattern;
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb')).toBeTrue();
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc')).toBeTrue();
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ESY5D')).toBeTrue();
            expect(
                pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?v=1&rpcids=hNvQHb&test=1'),
            ).toBeTrue();
        });

        it('should match generic batchexecute URLs without requiring rpcids', () => {
            const pattern = geminiAdapter.apiEndpointPattern;
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=otAQ7b')).toBeTrue();
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute')).toBeTrue();
        });

        it('should match StreamGenerate URL (Gemini 3.0 — V2.1-025)', () => {
            expect(
                geminiAdapter.apiEndpointPattern.test(
                    'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq_assistant-bard-web-server_20260210.04_p0&f.sid=-37108853284977362&hl=en&_reqid=2641802&rt=c',
                ),
            ).toBeTrue();
        });

        it('should match StreamGenerate as completion trigger (Gemini 3.0 — V2.1-025)', () => {
            expect(
                geminiAdapter.completionTriggerPattern.test(
                    'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq',
                ),
            ).toBeTrue();
        });

        it('should match completion trigger URLs for generic batchexecute RPCs', () => {
            const pattern = geminiAdapter.completionTriggerPattern;
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb')).toBeTrue();
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc')).toBeTrue();
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ESY5D')).toBeTrue();
        });
    });

    describe('Dual-match: URLs matching both apiEndpointPattern and completionTriggerPattern', () => {
        it('StreamGenerate matches BOTH patterns (documents the overlap)', () => {
            const url =
                'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';
            expect(geminiAdapter.apiEndpointPattern.test(url)).toBeTrue();
            expect(geminiAdapter.completionTriggerPattern?.test(url)).toBeTrue();
        });

        it('hNvQHb batchexecute matches BOTH patterns', () => {
            const url = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb';
            expect(geminiAdapter.apiEndpointPattern.test(url)).toBeTrue();
            expect(geminiAdapter.completionTriggerPattern?.test(url)).toBeTrue();
        });

        it('MaZiqc batchexecute matches completionTriggerPattern (suppressed at interceptor layer)', () => {
            const url = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc';
            expect(geminiAdapter.apiEndpointPattern.test(url)).toBeTrue();
            expect(geminiAdapter.completionTriggerPattern?.test(url)).toBeTrue();
        });

        it('extractConversationIdFromUrl returns null for StreamGenerate (no ID in URL)', () => {
            const url =
                'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';
            expect(geminiAdapter.extractConversationIdFromUrl?.(url)).toBeNull();
        });
    });

    describe('Conversation data parsing', () => {
        it('should parse a full conversation correctly (User + Assistant + Reasoning)', () => {
            const url = 'https://gemini.google.com/app/9cf87bbddf79d497';
            const result = geminiAdapter.parseInterceptedData(conversationResponseRaw, url);

            expect(result).not.toBeNull();
            if (!result) {
                return;
            }

            expect(result.conversation_id).toBe('9cf87bbddf79d497');
            expect(result.default_model_slug).toBe('gemini-3-pro');

            const messages = (Object.values(result.mapping) as MessageNode[])
                .map((n) => n.message)
                .filter((m): m is Message => m !== null);

            expect(messages.length).toBe(2);

            const userMsg = messages.find((m) => m.author.role === 'user')!;
            expect(userMsg).toBeDefined();
            const userText = userMsg.content.parts?.[0] || '';
            expect(userText.startsWith('ROLE: Expert academic translator')).toBeTrue();
            expect(userText.endsWith('دبر الصلوات يُؤتى بها ما يستطيع الإنسان وليس إلا.')).toBeTrue();

            const assistantMsg = messages.find((m) => m.author.role === 'assistant')!;
            expect(assistantMsg).toBeDefined();
            const assistantText = assistantMsg.content.parts?.[0] || '';
            expect(assistantText.startsWith('P258071 - The Shaykh: Yes.')).toBeTrue();
            expect(assistantText.endsWith('rforms of them what man is able, and nothing else.')).toBeTrue();

            const thoughts = assistantMsg.content.thoughts;
            expect(thoughts).toBeDefined();
            expect(thoughts!.length).toBe(7);
            expect(thoughts![0].summary).toBe('Clarifying Key Parameters');
            expect(thoughts![0].content.startsWith("I've established key parameters for the task. This")).toBeTrue();
            expect(thoughts![0].content.endsWith("ch involves a question on Ibn Ḥajar's assessments.")).toBeTrue();
        });
    });

    describe('Title parsing and race conditions', () => {
        it('should return null for titles endpoint and populate the cache', () => {
            const url = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc';
            const result = geminiAdapter.parseInterceptedData(titlesResponseRaw, url);
            expect(result).toBeNull();
        });

        it('should retroactively update conversation title when titles arrive AFTER data', () => {
            const uniqueId = 'test_race_condition';
            const modifiedConvData = conversationResponseRaw.replace('9cf87bbddf79d497', uniqueId);

            const convResult = geminiAdapter.parseInterceptedData(
                modifiedConvData,
                `https://gemini.google.com/app/${uniqueId}`,
            );
            expect(convResult).not.toBeNull();
            expect(convResult.title).toBe('Gemini Conversation');

            const expectedTitle = 'Test Retroactive Title';
            const modifiedTitles = titlesResponseRaw
                .replace('c_9cf87bbddf79d497', `c_${uniqueId}`)
                .replace('Hadith Authenticity and Narrator Discrepancies', expectedTitle);

            geminiAdapter.parseInterceptedData(
                modifiedTitles,
                'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc',
            );

            expect(convResult.title).toBe(expectedTitle);
        });

        it('should apply cached title if titles arrive BEFORE data', () => {
            const uniqueId = 'test_cached_title';
            const expectedTitle = 'Test Cached Title';

            const modifiedTitles = titlesResponseRaw
                .replace('c_69b38773dc8a64c7', `c_${uniqueId}`)
                .replace('Scholars Discuss Fiqh and Hadith', expectedTitle);

            geminiAdapter.parseInterceptedData(
                modifiedTitles,
                'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc',
            );

            const modifiedConvData = conversationResponseRaw.replace('9cf87bbddf79d497', uniqueId);
            const convResult = geminiAdapter.parseInterceptedData(
                modifiedConvData,
                `https://gemini.google.com/app/${uniqueId}`,
            );

            expect(convResult).not.toBeNull();
            expect(convResult?.title).toBe(expectedTitle);
        });

        it('should cache title candidates from non-conversation batchexecute RPCs using source-path conversation id', () => {
            const uniqueId = 'test_source_path_title';
            const expectedTitle = "Discussion on Istinja' Rulings";
            const titlePayload = JSON.stringify({ '11': [expectedTitle], '44': false });
            const chunk = JSON.stringify([['wrb.fr', 'ESY5D', titlePayload, null]]);
            const nonConversationResponse = `)]}'\n\n${chunk.length}\n${chunk}\n`;
            const sourcePathUrl = `https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ESY5D&source-path=%2Fapp%2F${uniqueId}&rt=c`;

            expect(geminiAdapter.parseInterceptedData(nonConversationResponse, sourcePathUrl)).toBeNull();

            const modifiedConvData = conversationResponseRaw.replace('9cf87bbddf79d497', uniqueId);
            const convResult = geminiAdapter.parseInterceptedData(
                modifiedConvData,
                `https://gemini.google.com/app/${uniqueId}`,
            );
            expect(convResult?.title).toBe(expectedTitle);
        });

        it('should retroactively update title from non-conversation batchexecute RPCs', () => {
            const uniqueId = 'test_source_path_title_after_data';
            const expectedTitle = "Discussion on Istinja' Rulings";

            const modifiedConvData = conversationResponseRaw.replace('9cf87bbddf79d497', uniqueId);
            const convResult = geminiAdapter.parseInterceptedData(
                modifiedConvData,
                `https://gemini.google.com/app/${uniqueId}`,
            );
            expect(convResult?.title).toBe('Gemini Conversation');

            const titlePayload = JSON.stringify({ '11': [expectedTitle], '44': false });
            const chunk = JSON.stringify([['wrb.fr', 'ESY5D', titlePayload, null]]);
            const nonConversationResponse = `)]}'\n\n${chunk.length}\n${chunk}\n`;
            const sourcePathUrl = `https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ESY5D&source-path=%2Fapp%2F${uniqueId}&rt=c`;

            expect(geminiAdapter.parseInterceptedData(nonConversationResponse, sourcePathUrl)).toBeNull();
            expect(convResult?.title).toBe(expectedTitle);
        });

        it('should ignore generic title candidates from non-conversation batchexecute RPCs', () => {
            const uniqueId = 'test_source_path_generic_title';
            const titlePayload = JSON.stringify({ '11': ['Google Gemini'] });
            const chunk = JSON.stringify([['wrb.fr', 'ESY5D', titlePayload, null]]);
            const nonConversationResponse = `)]}'\n\n${chunk.length}\n${chunk}\n`;
            const sourcePathUrl = `https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ESY5D&source-path=%2Fapp%2F${uniqueId}&rt=c`;

            expect(geminiAdapter.parseInterceptedData(nonConversationResponse, sourcePathUrl)).toBeNull();

            const modifiedConvData = conversationResponseRaw.replace('9cf87bbddf79d497', uniqueId);
            const convResult = geminiAdapter.parseInterceptedData(
                modifiedConvData,
                `https://gemini.google.com/app/${uniqueId}`,
            );
            expect(convResult?.title).toBe('Gemini Conversation');
        });

        it('should return null and warn (not error) for malformed MaZiqc title payload', () => {
            const malformedPayload = '{"broken"';
            const chunk = JSON.stringify([['wrb.fr', 'MaZiqc', malformedPayload, null]]);
            const response = `)]}'\n\n${chunk.length}\n${chunk}\n`;
            const url = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc';
            const errorCountBefore = loggerSpies.error.mock.calls.length;
            const warnCountBefore = loggerSpies.warn.mock.calls.length;

            const result = geminiAdapter.parseInterceptedData(response, url);
            expect(result).toBeNull();
            expect(loggerSpies.error.mock.calls.length).toBe(errorCountBefore);
            expect(loggerSpies.warn.mock.calls.length).toBeGreaterThan(warnCountBefore);
        });
    });

    describe('State isolation', () => {
        it('should clear cached titles when resetGeminiAdapterState is called', () => {
            const uniqueId = 'test_reset_title_cache';
            const expectedTitle = 'Reset Isolation Title';

            const modifiedTitles = titlesResponseRaw
                .replace('c_69b38773dc8a64c7', `c_${uniqueId}`)
                .replace('Scholars Discuss Fiqh and Hadith', expectedTitle);
            geminiAdapter.parseInterceptedData(
                modifiedTitles,
                'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc',
            );

            const modifiedConvData = conversationResponseRaw.replace('9cf87bbddf79d497', uniqueId);
            const withCache = geminiAdapter.parseInterceptedData(
                modifiedConvData,
                `https://gemini.google.com/app/${uniqueId}`,
            );
            expect(withCache?.title).toBe(expectedTitle);

            resetGeminiAdapterState();

            const afterReset = geminiAdapter.parseInterceptedData(
                modifiedConvData,
                `https://gemini.google.com/app/${uniqueId}`,
            );
            expect(afterReset?.title).toBe('Gemini Conversation');
        });
    });
});
