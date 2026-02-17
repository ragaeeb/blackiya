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
        it('should match batchexecute URLs even when rpcids drift', () => {
            const pattern = geminiAdapter.apiEndpointPattern;
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb')).toBe(true);
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc')).toBe(true);
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ESY5D')).toBe(true);
            expect(
                pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?v=1&rpcids=hNvQHb&test=1'),
            ).toBe(true);
        });

        it('should match generic batchexecute URLs without requiring rpcids', () => {
            const pattern = geminiAdapter.apiEndpointPattern;
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=otAQ7b')).toBe(true);
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute')).toBe(true);
        });

        it('should match StreamGenerate URL (Gemini 3.0 — V2.1-025)', () => {
            const pattern = geminiAdapter.apiEndpointPattern;
            expect(
                pattern.test(
                    'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq_assistant-bard-web-server_20260210.04_p0&f.sid=-37108853284977362&hl=en&_reqid=2641802&rt=c',
                ),
            ).toBe(true);
        });

        it('should match StreamGenerate as completion trigger (Gemini 3.0 — V2.1-025)', () => {
            const pattern = geminiAdapter.completionTriggerPattern;
            expect(
                pattern.test(
                    'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq',
                ),
            ).toBe(true);
        });

        it('should match completion trigger URLs for generic batchexecute RPCs', () => {
            const pattern = geminiAdapter.completionTriggerPattern;
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb')).toBe(true);
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc')).toBe(true);
            expect(pattern.test('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ESY5D')).toBe(true);
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

    describe('StreamGenerate parsing (V2.1-031)', () => {
        it('should parse a StreamGenerate multi-chunk response with conversation data', () => {
            // StreamGenerate format: ["wrb.fr", null, "PAYLOAD"] with shifted indices
            // payload = [null, ["c_convId", "r_respId"], null, null, [[candidateData]], ...]
            const convId = 'stream_test_conv_001';
            const assistantText = 'This is the assistant response from StreamGenerate.';

            // Build a realistic StreamGenerate multi-chunk response
            // Chunk 1: metadata-only (no conversation ID)
            const metaPayload = JSON.stringify([null, [null, 'r_resp1'], { '18': 'r_resp1' }]);
            const chunk1 = JSON.stringify([['wrb.fr', null, metaPayload, null]]);

            // Chunk 2: early conversation chunk with empty content
            const earlyPayload = JSON.stringify([
                null,
                [`c_${convId}`, 'r_resp1'],
                null,
                null,
                [['rc_cand1', [''], null]],
            ]);
            const chunk2 = JSON.stringify([['wrb.fr', null, earlyPayload, null]]);

            // Chunk 3: LAST chunk with full assistant content (this is the one we want)
            const fullPayload = JSON.stringify([
                null,
                [`c_${convId}`, 'r_resp1'],
                null,
                null,
                [
                    [
                        'rc_cand1',
                        [assistantText],
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
                        null,
                        ['Thinking step 1\n**Analysis**\nContent here'],
                    ],
                ],
            ]);
            const chunk3 = JSON.stringify([['wrb.fr', null, fullPayload, null]]);

            // Build length-prefixed response
            const response = `)]}'\n\n${chunk1.length}\n${chunk1}\n${chunk2.length}\n${chunk2}\n${chunk3.length}\n${chunk3}\n`;

            const url =
                'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';
            const result = geminiAdapter.parseInterceptedData(response, url);

            expect(result).not.toBeNull();
            if (!result) {
                return;
            }

            expect(result.conversation_id).toBe(convId);

            // Should have at least the assistant message
            const messages = Object.values(result.mapping)
                .map((n: any) => n.message)
                .filter((m: any) => m !== null);
            expect(messages.length).toBeGreaterThanOrEqual(1);

            const assistantMsg = messages.find((m: any) => m.author.role === 'assistant');
            expect(assistantMsg).toBeDefined();
            expect(assistantMsg!.content.parts?.[0]).toBe(assistantText);
        });

        it('should extract conversation ID from StreamGenerate even when user message is absent', () => {
            const convId = 'stream_test_conv_002';
            const payload = JSON.stringify([
                null,
                [`c_${convId}`, 'r_resp2'],
                null,
                null,
                [['rc_cand2', ['Reply'], null]],
            ]);
            const chunk = JSON.stringify([['wrb.fr', null, payload, null]]);
            const response = `)]}'\n\n${chunk.length}\n${chunk}\n`;

            const url =
                'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';
            const result = geminiAdapter.parseInterceptedData(response, url);

            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe(convId);
        });

        it('should prefer the LAST StreamGenerate chunk (richest content)', () => {
            const convId = 'stream_test_conv_003';
            const earlyPayload = JSON.stringify([
                null,
                [`c_${convId}`, 'r_resp3'],
                null,
                null,
                [['rc_cand3', ['Partial'], null]],
            ]);
            const fullPayload = JSON.stringify([
                null,
                [`c_${convId}`, 'r_resp3'],
                null,
                null,
                [['rc_cand3', ['Complete final answer here'], null]],
            ]);
            const chunk1 = JSON.stringify([['wrb.fr', null, earlyPayload, null]]);
            const chunk2 = JSON.stringify([['wrb.fr', null, fullPayload, null]]);
            const response = `)]}'\n\n${chunk1.length}\n${chunk1}\n${chunk2.length}\n${chunk2}\n`;

            const url =
                'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';
            const result = geminiAdapter.parseInterceptedData(response, url);

            expect(result).not.toBeNull();
            const assistantMsg = Object.values(result!.mapping)
                .map((n: any) => n.message)
                .filter((m: any) => m !== null)
                .find((m: any) => m.author.role === 'assistant');
            expect(assistantMsg?.content.parts?.[0]).toBe('Complete final answer here');
        });

        it('should extract thinking/reasoning from StreamGenerate chunks', () => {
            const convId = 'stream_test_conv_004';
            const thinkingText =
                '\n**Analyzing the Problem**\nI need to figure this out.\n**Developing Solution**\nHere is the approach.';
            const payload = JSON.stringify([
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
            ]);
            const chunk = JSON.stringify([['wrb.fr', null, payload, null]]);
            const response = `)]}'\n\n${chunk.length}\n${chunk}\n`;

            const url =
                'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';
            const result = geminiAdapter.parseInterceptedData(response, url);

            expect(result).not.toBeNull();
            const assistantMsg = Object.values(result!.mapping)
                .map((n: any) => n.message)
                .filter((m: any) => m !== null)
                .find((m: any) => m.author.role === 'assistant');
            expect(assistantMsg?.content.thoughts).toBeDefined();
            expect(assistantMsg?.content.thoughts?.length).toBe(2);
            expect(assistantMsg?.content.thoughts?.[0].summary).toBe('Analyzing the Problem');
        });
    });

    describe('Dual-match: URLs matching both apiEndpointPattern AND completionTriggerPattern', () => {
        it('StreamGenerate matches BOTH patterns (XHR timing is OK, but documents the overlap)', () => {
            const url =
                'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';
            expect(geminiAdapter.apiEndpointPattern.test(url)).toBe(true);
            expect(geminiAdapter.completionTriggerPattern?.test(url)).toBe(true);
        });

        it('hNvQHb batchexecute matches BOTH patterns', () => {
            const url = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb';
            expect(geminiAdapter.apiEndpointPattern.test(url)).toBe(true);
            expect(geminiAdapter.completionTriggerPattern?.test(url)).toBe(true);
        });

        it('MaZiqc batchexecute matches completionTriggerPattern (suppressed at interceptor layer)', () => {
            const url = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc';
            expect(geminiAdapter.apiEndpointPattern.test(url)).toBe(true);
            expect(geminiAdapter.completionTriggerPattern?.test(url)).toBe(true);
        });

        it('extractConversationIdFromUrl returns null for StreamGenerate (no ID in URL)', () => {
            const url =
                'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq';
            expect(geminiAdapter.extractConversationIdFromUrl?.(url)).toBeNull();
        });
    });
});
