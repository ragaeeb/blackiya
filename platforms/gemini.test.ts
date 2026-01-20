import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { join } from 'node:path';

// Mock wxt/browser explicitly to avoid logging errors
const browserMock = {
    storage: {
        local: {
            get: async () => ({}),
            set: async () => {},
        },
    },
    runtime: {
        getURL: () => 'chrome-extension://mock/',
    },
};
mock.module('wxt/browser', () => ({
    browser: browserMock,
}));

// Mock logger locally to ensure it's applied
mock.module('@/utils/logger', () => ({
    logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    },
}));

// Mock logger locally to ensure it's applied
mock.module('@/utils/logger', () => ({
    logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    },
}));

// ... mocks are defined above ...

import type { Message, MessageNode } from '@/utils/types';

describe('Gemini Platform Adapter', () => {
    let conversationResponseRaw: string;
    let titlesResponseRaw: string;
    let geminiAdapter: any;

    beforeAll(async () => {
        // Dynamic import to ensure mocks apply
        const module = await import('@/platforms/gemini');
        geminiAdapter = module.geminiAdapter;

        // Load test fixtures
        conversationResponseRaw = await Bun.file(
            join(import.meta.dir, '..', 'data', 'gemini', 'sample_gemini_conversation.txt'),
        ).text();
        titlesResponseRaw = await Bun.file(
            join(import.meta.dir, '..', 'data', 'gemini', 'sample_gemini_titles.txt'),
        ).text();
    });

    describe('URL Handling', () => {
        it('should identify Gemini URLs', () => {
            expect(geminiAdapter.isPlatformUrl('https://gemini.google.com/app/12345')).toBe(true);
            expect(geminiAdapter.isPlatformUrl('https://gemini.google.com/')).toBe(true);
            expect(geminiAdapter.isPlatformUrl('https://google.com')).toBe(false);
        });

        it('should extract conversation IDs', () => {
            expect(geminiAdapter.extractConversationId('https://gemini.google.com/app/abcdef123')).toBe('abcdef123');
            expect(geminiAdapter.extractConversationId('https://gemini.google.com/share/shared_id_123')).toBe(
                'shared_id_123',
            );
            expect(geminiAdapter.extractConversationId('https://gemini.google.com')).toBeNull();
        });
    });

    describe('API Pattern Matching', () => {
        it('should match valid batchexecute URLs', () => {
            const pattern = geminiAdapter.apiEndpointPattern;
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb')).toBe(true);
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc')).toBe(true);
            expect(
                pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?v=1&rpcids=hNvQHb&test=1'),
            ).toBe(true);
        });

        it('should NOT match irrelevant batchexecute URLs', () => {
            const pattern = geminiAdapter.apiEndpointPattern;
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=otAQ7b')).toBe(false);
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute')).toBe(false); // No rpcids
        });
    });

    describe('Conversation Data Parsing', () => {
        it('should parse a full conversation correctly (User + Assistant + Reasoning)', () => {
            const url = 'https://gemini.google.com/app/9cf87bbddf79d497';
            const result = geminiAdapter.parseInterceptedData(conversationResponseRaw, url);

            expect(result).not.toBeNull();
            if (!result) {
                return;
            }

            expect(result.conversation_id).toBe('9cf87bbddf79d497');
            expect(result.default_model_slug).toBe('gemini-3-pro');

            const mapping = result.mapping;
            expect(mapping).toBeDefined();

            // Filter out null messages to avoid TS errors
            const messages = (Object.values(mapping) as MessageNode[])
                .map((n) => n.message)
                .filter((m): m is Message => m !== null);

            expect(messages.length).toBe(2);

            // 1. Strict User Message Validation
            const userMsg = messages.find((m) => m.author.role === 'user')!;
            expect(userMsg).toBeDefined();
            const userText = userMsg.content.parts?.[0] || '';

            expect(userText.startsWith('ROLE: Expert academic translator')).toBe(true);
            expect(userText.endsWith('دبر الصلوات يُؤتى بها ما يستطيع الإنسان وليس إلا.')).toBe(true);

            // 2. Strict Assistant Message Validation
            const assistantMsg = messages.find((m) => m.author.role === 'assistant')!;
            expect(assistantMsg).toBeDefined();
            const assistantText = assistantMsg.content.parts?.[0] || '';

            expect(assistantText.startsWith('P258071 - The Shaykh: Yes.')).toBe(true);
            expect(assistantText.endsWith('rforms of them what man is able, and nothing else.')).toBe(true);

            // 3. Strict Reasoning/Thoughts Validation
            const thoughts = assistantMsg.content.thoughts;
            expect(thoughts).toBeDefined();
            expect(thoughts!.length).toBe(7);

            const firstThought = thoughts![0];
            expect(firstThought.summary).toBe('Clarifying Key Parameters');
            expect(firstThought.content.startsWith("I've established key parameters for the task. This")).toBe(true);
            expect(firstThought.content.endsWith("ch involves a question on Ibn Ḥajar's assessments.")).toBe(true);
        });
    });

    describe('Title Parsing & Race Conditions', () => {
        it('should extract titles and update cache', () => {
            const url = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc';
            const result = geminiAdapter.parseInterceptedData(titlesResponseRaw, url);
            expect(result).toBeNull();
        });

        it('should retroactively update conversation title when titles arrive AFTER data', () => {
            const uniqueId = 'test_race_condition';
            // Use a unique ID to avoid interference with other tests
            const modifiedConvData = conversationResponseRaw.replace('9cf87bbddf79d497', uniqueId);

            const convResult = geminiAdapter.parseInterceptedData(
                modifiedConvData,
                `https://gemini.google.com/app/${uniqueId}`,
            );

            expect(convResult).not.toBeNull();
            if (!convResult) {
                return;
            }
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
    });
});
