import { beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';

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

        it('should match completion trigger URLs for conversation RPC', () => {
            const pattern = geminiAdapter.completionTriggerPattern;
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb')).toBe(true);
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc')).toBe(false);
        });

        it('should return null when extracting conversation ID from Gemini API URL', () => {
            expect(
                geminiAdapter.extractConversationIdFromUrl(
                    'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb',
                ),
            ).toBeNull();
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

    describe('evaluateReadiness', () => {
        it('returns not-ready for thoughts-only assistant payloads', () => {
            const readiness = geminiAdapter.evaluateReadiness?.({
                title: 'Gemini Conversation',
                create_time: 1,
                update_time: 2,
                conversation_id: 'abc123',
                current_node: 'assistant-1',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gemini-pro',
                safe_urls: [],
                blocked_urls: [],
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['assistant-1'] },
                    'assistant-1': {
                        id: 'assistant-1',
                        parent: 'root',
                        children: [],
                        message: {
                            id: 'assistant-1',
                            author: { role: 'assistant', name: 'Gemini', metadata: {} },
                            create_time: 1,
                            update_time: 2,
                            content: {
                                content_type: 'thoughts',
                                thoughts: [{ summary: 'Thinking', content: 'Draft', chunks: [], finished: true }],
                            },
                            status: 'finished_successfully',
                            end_turn: false,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                    },
                },
            });

            expect(readiness?.ready).toBe(false);
            expect(readiness?.reason).toBe('assistant-text-missing');
        });

        it('returns ready for terminal assistant text payloads', () => {
            const readiness = geminiAdapter.evaluateReadiness?.({
                title: 'Gemini Conversation',
                create_time: 1,
                update_time: 3,
                conversation_id: 'abc123',
                current_node: 'assistant-2',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gemini-pro',
                safe_urls: [],
                blocked_urls: [],
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['assistant-1'] },
                    'assistant-1': {
                        id: 'assistant-1',
                        parent: 'root',
                        children: ['assistant-2'],
                        message: {
                            id: 'assistant-1',
                            author: { role: 'assistant', name: 'Gemini', metadata: {} },
                            create_time: 1,
                            update_time: 2,
                            content: {
                                content_type: 'thoughts',
                                thoughts: [{ summary: 'Thinking', content: 'Draft', chunks: [], finished: true }],
                            },
                            status: 'finished_successfully',
                            end_turn: false,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                    },
                    'assistant-2': {
                        id: 'assistant-2',
                        parent: 'assistant-1',
                        children: [],
                        message: {
                            id: 'assistant-2',
                            author: { role: 'assistant', name: 'Gemini', metadata: {} },
                            create_time: 2,
                            update_time: 3,
                            content: { content_type: 'text', parts: ['Final answer'] },
                            status: 'finished_successfully',
                            end_turn: true,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                    },
                },
            });

            expect(readiness?.ready).toBe(true);
            expect(readiness?.terminal).toBe(true);
            expect(readiness?.contentHash).not.toBeNull();
        });
    });
});
