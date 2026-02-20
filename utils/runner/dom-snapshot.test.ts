import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { LLMPlatform } from '@/platforms/types';
import {
    buildConversationSnapshotFromMessages,
    buildIsolatedDomSnapshot,
    buildRunnerSnapshotConversationData,
    collectLastResortTextCandidates,
    collectLooseGrokCandidates,
    collectSnapshotMessageCandidates,
    normalizeSnapshotText,
    queryAllFromRoot,
} from '@/utils/runner/dom-snapshot';

describe('dom-snapshot', () => {
    describe('buildConversationSnapshotFromMessages', () => {
        it('should return null if no conversationId or empty messages', () => {
            expect(buildConversationSnapshotFromMessages('', 'Title', [{ role: 'user', text: 'hi' }])).toBeNull();
            expect(buildConversationSnapshotFromMessages('123', 'Title', [])).toBeNull();
        });

        it('should build a snapshot from messages with a synthetic root', () => {
            const result = buildConversationSnapshotFromMessages('123', 'My Title', [
                { role: 'user', text: 'hello' },
                { role: 'assistant', text: 'hi there' },
            ]);

            expect(result).not.toBeNull();
            expect(result!.title).toBe('My Title');
            expect(result!.conversation_id).toBe('123');
            expect(Object.keys(result!.mapping).length).toBe(3); // root + 2 msgs
            expect(result!.mapping['root']).toBeDefined();
            expect(result!.mapping['snapshot-0']).toBeDefined();
            expect(result!.mapping['snapshot-1']).toBeDefined();
            expect(result!.mapping['snapshot-0'].message!.content!.parts![0]).toBe('hello');
            expect(result!.mapping['snapshot-0'].message!.author.role).toBe('user');
            expect(result!.mapping['snapshot-1'].message!.content!.parts![0]).toBe('hi there');
        });
    });

    describe('buildRunnerSnapshotConversationData', () => {
        it('should return null if no conversationId or empty messages', () => {
            expect(buildRunnerSnapshotConversationData('', 'ChatGPT', [{ role: 'user', text: 'hi' }])).toBeNull();
            expect(buildRunnerSnapshotConversationData('123', 'ChatGPT', [])).toBeNull();
        });

        it('should build conversation data with correct child-parent links', () => {
            const result = buildRunnerSnapshotConversationData(
                '123',
                'Grok',
                [
                    { role: 'user', text: 'q1' },
                    { role: 'assistant', text: 'a1' },
                ],
                'Doc title',
            );

            expect(result).not.toBeNull();
            expect(result!.title).toBe('Doc title');
            expect(result!.conversation_id).toBe('123');
            expect(Object.keys(result!.mapping).length).toBe(2);

            const map = result!.mapping;
            expect(map['snapshot-1']).toBeDefined();
            expect(map['snapshot-2']).toBeDefined();

            expect(map['snapshot-1'].parent).toBeNull();
            expect(map['snapshot-1'].children).toEqual(['snapshot-2']);
            expect(map['snapshot-1'].message!.author.name).toBe('User');

            expect(map['snapshot-2'].parent).toBe('snapshot-1');
            expect(map['snapshot-2'].children).toEqual([]);
            expect(map['snapshot-2'].message!.author.name).toBe('Grok');
        });
    });

    describe('normalizeSnapshotText', () => {
        it('should trim and condense whitespace', () => {
            expect(normalizeSnapshotText('  foo \n  bar   baz ')).toBe('foo bar baz');
        });
    });

    describe('queryAllFromRoot', () => {
        it('should safely return empty array if querySelectorAll fails or unavailable', () => {
            expect(queryAllFromRoot(null as any, '.cls')).toEqual([]);
            expect(queryAllFromRoot({} as any, '.cls')).toEqual([]);
            expect(
                queryAllFromRoot(
                    {
                        querySelectorAll: () => {
                            throw new Error();
                        },
                    } as any,
                    '.cls',
                ),
            ).toEqual([]);
        });

        it('should return elements if querySelectorAll succeeds', () => {
            const root = {
                querySelectorAll: mock((sel) => [{ id: 1 }, { id: 2 }]),
            };
            expect(queryAllFromRoot(root as any, '.cls')).toEqual([{ id: 1 }, { id: 2 }] as any);
        });
    });

    describe('collectSnapshotMessageCandidates', () => {
        it('should collect and dedupe candidates based on selectors', () => {
            const root = {
                querySelectorAll: mock((selector: string) => {
                    if (selector.includes('user')) {
                        return [{ textContent: 'hello world' }, { textContent: 'hello world' }]; // duplicate
                    }
                    if (selector.includes('assistant')) {
                        return [{ textContent: 'hi back' }];
                    }
                    return [];
                }),
            };

            const result = collectSnapshotMessageCandidates(root as any);
            expect(result).toHaveLength(2); // deduped
            // Will match multiple selectors, but dedupe should handle it
            expect(result).toContainEqual({ role: 'user', text: 'hello world' });
            expect(result).toContainEqual({ role: 'assistant', text: 'hi back' });
        });
    });

    describe('collectLooseGrokCandidates', () => {
        it('should collect alternating candidates for grok from main articles', () => {
            const root = {
                querySelectorAll: mock((sel) => [
                    { textContent: 'a long question for grok' },
                    { textContent: 'an equally long response from grok' },
                ]),
            };

            const result = collectLooseGrokCandidates(root as any);
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({ role: 'user', text: 'a long question for grok' });
            expect(result[1]).toEqual({ role: 'assistant', text: 'an equally long response from grok' });
        });

        it('should return empty if less than 2 valid texts', () => {
            const root = { querySelectorAll: () => [{ textContent: 'short' }] };
            expect(collectLooseGrokCandidates(root as any)).toEqual([]);
        });
    });

    describe('buildIsolatedDomSnapshot', () => {
        let originalDocumentQuerySelector: typeof globalThis.document.querySelector;
        let originalDocumentBody: HTMLElement;

        let originalDocumentTitle: string;

        beforeEach(() => {
            originalDocumentQuerySelector = globalThis.document?.querySelector;
            originalDocumentBody = globalThis.document?.body;
            originalDocumentTitle = globalThis.document?.title;

            if (!globalThis.document) {
                (globalThis as any).document = {};
            }
            (globalThis.document as any).title = 'Test Title';
        });

        afterEach(() => {
            if (globalThis.document) {
                globalThis.document.querySelector = originalDocumentQuerySelector;
                globalThis.document.body = originalDocumentBody;
                globalThis.document.title = originalDocumentTitle;
            }
        });

        it('should return null if no roots or no valid candidates', () => {
            (globalThis.document as any).querySelector = () => null;
            (globalThis.document as any).body = null;

            const adapter = { name: 'ChatGPT' } as LLMPlatform;
            expect(buildIsolatedDomSnapshot(adapter, '123')).toBeNull();
        });

        it('should build primary snapshot if valid candidates found in body', () => {
            (globalThis.document as any).querySelector = () => null;
            (globalThis.document as any).body = {
                querySelectorAll: (sel: string) => {
                    if (sel.includes('user')) {
                        return [{ textContent: 'user msg' }];
                    }
                    if (sel.includes('assistant')) {
                        return [{ textContent: 'assistant msg' }];
                    }
                    return [];
                },
            };

            const adapter = { name: 'ChatGPT' } as LLMPlatform;
            const result = buildIsolatedDomSnapshot(adapter, '123');
            expect(result).not.toBeNull();
            expect(Object.keys(result!.mapping).length).toBe(2);
        });

        it('should fallback to loose Grok candidates if Grok adapter and primary fails', () => {
            (globalThis.document as any).querySelector = () => null;
            (globalThis.document as any).body = {
                querySelectorAll: (sel: string) => {
                    // primary fails by returning empty for user/assistant roles
                    // but loose fallback returns on main article
                    if (sel.includes('main article')) {
                        return [{ textContent: 'long enough user msg' }, { textContent: 'long enough assistant msg' }];
                    }
                    return [];
                },
            };

            const adapter = { name: 'Grok' } as LLMPlatform;
            const result = buildIsolatedDomSnapshot(adapter, '123');
            expect(result).not.toBeNull();
            expect(Object.keys(result!.mapping).length).toBe(2);
        });
    });
});
