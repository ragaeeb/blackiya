import { describe, expect, it } from 'bun:test';

import {
    extractAssistantTextSnapshotFromSseBuffer,
    extractLikelyTextFromSsePayload,
    extractTitleFromSsePayload,
} from './text-extraction';

describe('text-extraction', () => {
    describe('extractLikelyTextFromSsePayload', () => {
        it('should not let preferred-key recursion duplicates exhaust candidate collection', () => {
            const payload: Record<string, unknown> = {
                content: Array.from({ length: 60 }, (_, i) => `preferred-${i}`),
            };
            for (let i = 0; i < 30; i++) {
                payload[`tail_${i}`] = `tail-${i}`;
            }

            const values = extractLikelyTextFromSsePayload(JSON.stringify(payload));
            expect(values).toContain('preferred-0');
            expect(values).toContain('tail-0');
        });

        it('should return empty array for non-JSON input', () => {
            expect(extractLikelyTextFromSsePayload('not json')).toEqual([]);
            expect(extractLikelyTextFromSsePayload('')).toEqual([]);
        });

        it('should deduplicate repeated string values', () => {
            const payload = { text: 'hello', message: 'hello' };
            const values = extractLikelyTextFromSsePayload(JSON.stringify(payload));
            expect(values.filter((v) => v === 'hello').length).toBe(1);
        });

        it('should filter out version strings like v1 or V10', () => {
            const payload = { text: 'v1', content: 'real text here' };
            const values = extractLikelyTextFromSsePayload(JSON.stringify(payload));
            expect(values).not.toContain('v1');
            expect(values).toContain('real text here');
        });

        it('should filter out hex ID strings (24+ chars)', () => {
            const payload = { text: 'aabbccdd-eeff-1122-3344-556677889900', content: 'readable text' };
            const values = extractLikelyTextFromSsePayload(JSON.stringify(payload));
            expect(values).not.toContain('aabbccdd-eeff-1122-3344-556677889900');
            expect(values).toContain('readable text');
        });

        it('should filter out URLs', () => {
            const payload = { text: 'https://example.com/api', content: 'meaningful text' };
            const values = extractLikelyTextFromSsePayload(JSON.stringify(payload));
            expect(values).not.toContain('https://example.com/api');
            expect(values).toContain('meaningful text');
        });

        it('should filter out pure punctuation strings', () => {
            const payload = { text: '...', content: 'actual content' };
            const values = extractLikelyTextFromSsePayload(JSON.stringify(payload));
            expect(values).not.toContain('...');
            expect(values).toContain('actual content');
        });

        it('should filter out single-character strings', () => {
            const payload = { text: 'a', content: 'longer text here' };
            const values = extractLikelyTextFromSsePayload(JSON.stringify(payload));
            expect(values).not.toContain('a');
        });

        it('should filter out strings longer than 4000 characters', () => {
            const longString = 'x'.repeat(4001);
            const payload = { text: longString, content: 'short text' };
            const values = extractLikelyTextFromSsePayload(JSON.stringify(payload));
            expect(values).not.toContain(longString);
            expect(values).toContain('short text');
        });

        it('should filter out http:// URLs', () => {
            const payload = { text: 'http://example.com/path', content: 'good text' };
            const values = extractLikelyTextFromSsePayload(JSON.stringify(payload));
            expect(values).not.toContain('http://example.com/path');
        });
    });

    describe('extractTitleFromSsePayload', () => {
        it('should return null for non-JSON input', () => {
            expect(extractTitleFromSsePayload('not json')).toBeNull();
            expect(extractTitleFromSsePayload('')).toBeNull();
        });

        it('should return null when type is not title_generation', () => {
            const payload = JSON.stringify({ type: 'content_block', title: 'My Title' });
            expect(extractTitleFromSsePayload(payload)).toBeNull();
        });

        it('should return null when title is missing', () => {
            const payload = JSON.stringify({ type: 'title_generation' });
            expect(extractTitleFromSsePayload(payload)).toBeNull();
        });

        it('should return null when title is empty or whitespace-only', () => {
            const payload = JSON.stringify({ type: 'title_generation', title: '   ' });
            expect(extractTitleFromSsePayload(payload)).toBeNull();
        });

        it('should extract and trim title from a valid title_generation frame', () => {
            const payload = JSON.stringify({ type: 'title_generation', title: '  My Conversation  ' });
            expect(extractTitleFromSsePayload(payload)).toBe('My Conversation');
        });
    });

    describe('extractAssistantTextSnapshotFromSseBuffer', () => {
        const VALID_CONV_ID = '696bc3d5-fa84-8328-b209-4d65cb229e59';

        it('should return null when the buffer cannot be parsed by the ChatGPT adapter', () => {
            expect(extractAssistantTextSnapshotFromSseBuffer('not valid sse')).toBeNull();
        });

        it('should return null for an empty buffer', () => {
            expect(extractAssistantTextSnapshotFromSseBuffer('')).toBeNull();
        });

        it('should return null when parsed conversation has no assistant messages', () => {
            // A conversation with only a user message — no assistant node
            const json = JSON.stringify({
                conversation_id: VALID_CONV_ID,
                title: 'Test',
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['u1'] },
                    u1: {
                        id: 'u1',
                        parent: 'root',
                        children: [],
                        message: {
                            id: 'u1',
                            author: { role: 'user', name: null, metadata: {} },
                            create_time: 1,
                            update_time: 1,
                            content: { content_type: 'text', parts: ['Hello'] },
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
            expect(extractAssistantTextSnapshotFromSseBuffer(json)).toBeNull();
        });

        it('should return the assistant text when the buffer parses successfully', () => {
            const json = JSON.stringify({
                conversation_id: VALID_CONV_ID,
                title: 'Test',
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['a1'] },
                    a1: {
                        id: 'a1',
                        parent: 'root',
                        children: [],
                        message: {
                            id: 'a1',
                            author: { role: 'assistant', name: null, metadata: {} },
                            create_time: 2,
                            update_time: 2,
                            content: { content_type: 'text', parts: ['Hello from assistant'] },
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
            const result = extractAssistantTextSnapshotFromSseBuffer(json);
            expect(result).toBe('Hello from assistant');
        });

        it('should return null when the latest assistant message text is empty', () => {
            const json = JSON.stringify({
                conversation_id: VALID_CONV_ID,
                title: 'Test',
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['a1'] },
                    a1: {
                        id: 'a1',
                        parent: 'root',
                        children: [],
                        message: {
                            id: 'a1',
                            author: { role: 'assistant', name: null, metadata: {} },
                            create_time: 2,
                            update_time: 2,
                            content: { content_type: 'text', parts: ['   '] },
                            status: 'in_progress',
                            end_turn: false,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                    },
                },
            });
            expect(extractAssistantTextSnapshotFromSseBuffer(json)).toBeNull();
        });

        it('should return null when the latest assistant text is a version string', () => {
            const json = JSON.stringify({
                conversation_id: VALID_CONV_ID,
                title: 'Test',
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['a1'] },
                    a1: {
                        id: 'a1',
                        parent: 'root',
                        children: [],
                        message: {
                            id: 'a1',
                            author: { role: 'assistant', name: null, metadata: {} },
                            create_time: 2,
                            update_time: 2,
                            content: { content_type: 'text', parts: ['v2'] },
                            status: 'in_progress',
                            end_turn: false,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                    },
                },
            });
            expect(extractAssistantTextSnapshotFromSseBuffer(json)).toBeNull();
        });
    });
});
