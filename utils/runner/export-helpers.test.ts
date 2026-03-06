import { describe, expect, it } from 'bun:test';
import { attachExportMeta, extractResponseTextFromConversation } from '@/utils/runner/export-helpers';
import type { ExportMeta } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

describe('export-helpers', () => {
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
        it('should return latest-turn assistant response text', () => {
            const data = {
                conversation_id: 'conv-1',
                current_node: 'assistant',
                mapping: {
                    user: {
                        id: 'user',
                        parent: null,
                        children: ['assistant'],
                        message: {
                            id: 'user',
                            author: { role: 'user' },
                            content: { parts: ['some prompt'] },
                        },
                    },
                    assistant: {
                        id: 'assistant',
                        parent: 'user',
                        children: [],
                        message: {
                            id: 'assistant',
                            author: { role: 'assistant' },
                            content: { parts: ['some response'] },
                        },
                    },
                },
            } as any as ConversationData;

            expect(extractResponseTextFromConversation(data)).toBe('some response');
        });

        it('should return prompt info if no assistant response exists yet', () => {
            const data = {
                conversation_id: 'conv-1',
                current_node: 'user',
                mapping: {
                    user: {
                        id: 'user',
                        parent: null,
                        children: [],
                        message: {
                            id: 'user',
                            author: { role: 'user' },
                            content: { parts: ['some prompt'] },
                        },
                    },
                },
            } as any as ConversationData;

            expect(extractResponseTextFromConversation(data)).toContain('some prompt');
        });

        it('should fallback to raw assistant message extraction when the current turn is incomplete', () => {
            const data = {
                conversation_id: 'conv-1',
                current_node: 'missing',
                mapping: {
                    node1: { message: { author: { role: 'assistant' }, content: { parts: ['first'] } } },
                    node2: { message: { author: { role: 'user' }, content: { parts: ['ignored'] } } },
                    node3: { message: { author: { role: 'assistant' }, content: { parts: ['second'] } } },
                },
            } as any as ConversationData;

            expect(extractResponseTextFromConversation(data)).toBe('first\n\nsecond');
        });
    });
});
