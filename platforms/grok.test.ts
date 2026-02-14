/**
 * Tests for Grok Platform Adapter
 *
 * TDD tests for conversation ID extraction, API URL matching, and data parsing
 */

import { beforeAll, describe, expect, it, mock } from 'bun:test';

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

// Mock logger locally to ensure it's applied before grok adapter loads
mock.module('@/utils/logger', () => ({
    logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    },
}));

import sampleConversation from '@/data/grok/sample_grok_conversation.json';
import sampleHistory from '@/data/grok/sample_grok_history.json';
import type { MessageNode } from '@/utils/types';

describe('Grok Platform Adapter', () => {
    let grokAdapter: any;

    beforeAll(async () => {
        const mod = await import('@/platforms/grok');
        grokAdapter = mod.grokAdapter;
    });

    describe('extractConversationId', () => {
        it('should extract conversation ID from standard Grok URL', () => {
            const url = 'https://x.com/i/grok?conversation=2013295304527827227';
            const id = grokAdapter.extractConversationId(url);
            expect(id).toBe('2013295304527827227');
        });

        it('should extract conversation ID from grok.com URL', () => {
            const url =
                'https://grok.com/c/01cb0729-6455-471d-b33a-124b3de76a29?rid=70bc533c-9bfb-4321-b10f-facaed644858';
            const id = grokAdapter.extractConversationId(url);
            expect(id).toBe('01cb0729-6455-471d-b33a-124b3de76a29');
        });

        it('should extract conversation ID from URL with additional query parameters', () => {
            const url = 'https://x.com/i/grok?conversation=2013295304527827227&mode=normal';
            const id = grokAdapter.extractConversationId(url);
            expect(id).toBe('2013295304527827227');
        });

        it('should return null for Grok URL without conversation parameter', () => {
            const url = 'https://x.com/i/grok';
            const id = grokAdapter.extractConversationId(url);
            expect(id).toBeNull();
        });

        it('should return null for non-Grok URL', () => {
            const url = 'https://x.com/home';
            const id = grokAdapter.extractConversationId(url);
            expect(id).toBeNull();
        });

        it('should return null for non-x.com domain', () => {
            const url = 'https://twitter.com/i/grok?conversation=123456789';
            const id = grokAdapter.extractConversationId(url);
            expect(id).toBeNull();
        });

        it('should return null for invalid conversation ID format', () => {
            const url = 'https://x.com/i/grok?conversation=invalid-id';
            const id = grokAdapter.extractConversationId(url);
            expect(id).toBeNull();
        });

        it('should return null for very long numeric conversation IDs', () => {
            const url = 'https://x.com/i/grok?conversation=20132953045278272271234567890';
            const id = grokAdapter.extractConversationId(url);
            expect(id).toBeNull(); // Too long (> 20 digits)
        });

        it('should handle minimum length numeric IDs', () => {
            const url = 'https://x.com/i/grok?conversation=1234567890';
            const id = grokAdapter.extractConversationId(url);
            expect(id).toBe('1234567890');
        });
    });

    describe('isPlatformUrl', () => {
        it('should recognize valid Grok URLs', () => {
            expect(grokAdapter.isPlatformUrl('https://x.com/i/grok?conversation=123')).toBe(true);
            expect(grokAdapter.isPlatformUrl('https://x.com/i/grok')).toBe(true);
            expect(grokAdapter.isPlatformUrl('https://grok.com/c/01cb0729-6455-471d-b33a-124b3de76a29')).toBe(true);
            expect(grokAdapter.isPlatformUrl('https://grok.com/')).toBe(true);
        });

        it('should reject non-Grok URLs', () => {
            expect(grokAdapter.isPlatformUrl('https://x.com/home')).toBe(false);
            expect(grokAdapter.isPlatformUrl('https://chatgpt.com')).toBe(false);
        });
    });

    describe('apiEndpointPattern', () => {
        it('should match Grok GraphQL conversation endpoint', () => {
            const endpoint =
                'https://x.com/i/api/graphql/6QmFgXuRQyOnW2iJ7nIk7g/GrokConversationItemsByRestId?variables=%7B%22restId%22%3A%222013295304527827227%22%7D';
            expect(grokAdapter.apiEndpointPattern.test(endpoint)).toBe(true);
        });

        it('should match GrokHistory endpoint', () => {
            const endpoint = 'https://x.com/i/api/graphql/9Hyh5D4-WXLnExZkONSkZg/GrokHistory?variables=%7B%7D';
            expect(grokAdapter.apiEndpointPattern.test(endpoint)).toBe(true);
        });

        it('should match grok.com conversation endpoints', () => {
            const pattern = grokAdapter.apiEndpointPattern;
            expect(
                pattern.test(
                    'https://grok.com/rest/app-chat/conversations_v2/01cb0729-6455-471d-b33a-124b3de76a29?includeWorkspaces=true&includeTaskResult=true',
                ),
            ).toBe(true);
            expect(
                pattern.test(
                    'https://grok.com/rest/app-chat/conversations/01cb0729-6455-471d-b33a-124b3de76a29/response-node?includeThreads=true',
                ),
            ).toBe(true);
            expect(
                pattern.test(
                    'https://grok.com/rest/app-chat/conversations/01cb0729-6455-471d-b33a-124b3de76a29/load-responses',
                ),
            ).toBe(true);
        });

        it('should not match other GraphQL endpoints', () => {
            const endpoint = 'https://x.com/i/api/graphql/abc123/UserByScreenName';
            expect(grokAdapter.apiEndpointPattern.test(endpoint)).toBe(false);
        });

        it('should not match non-API URLs', () => {
            const endpoint = 'https://x.com/i/grok?conversation=123';
            expect(grokAdapter.apiEndpointPattern.test(endpoint)).toBe(false);
        });

        it('should match completion trigger URLs for x.com and grok.com response endpoints', () => {
            const pattern = grokAdapter.completionTriggerPattern;
            expect(
                pattern.test(
                    'https://x.com/i/api/graphql/6QmFgXuRQyOnW2iJ7nIk7g/GrokConversationItemsByRestId?variables=%7B%22restId%22%3A%222013295304527827227%22%7D',
                ),
            ).toBe(true);
            expect(
                pattern.test(
                    'https://grok.com/rest/app-chat/conversations/01cb0729-6455-471d-b33a-124b3de76a29/load-responses',
                ),
            ).toBe(true);
            expect(
                pattern.test('https://x.com/i/api/graphql/9Hyh5D4-WXLnExZkONSkZg/GrokHistory?variables=%7B%7D'),
            ).toBe(false);
        });
    });

    describe('extractConversationIdFromUrl', () => {
        it('should extract x.com restId from GraphQL variables', () => {
            const variables = JSON.stringify({ restId: '2013295304527827227' });
            const url = `https://x.com/i/api/graphql/6QmFgXuRQyOnW2iJ7nIk7g/GrokConversationItemsByRestId?variables=${encodeURIComponent(variables)}`;
            expect(grokAdapter.extractConversationIdFromUrl(url)).toBe('2013295304527827227');
        });

        it('should extract grok.com UUID from REST URLs', () => {
            const url =
                'https://grok.com/rest/app-chat/conversations/01cb0729-6455-471d-b33a-124b3de76a29/load-responses';
            expect(grokAdapter.extractConversationIdFromUrl(url)).toBe('01cb0729-6455-471d-b33a-124b3de76a29');
        });
    });

    describe('buildApiUrls', () => {
        it('should provide grok.com fetch candidates for UUID conversation IDs', () => {
            const id = '01cb0729-6455-471d-b33a-124b3de76a29';
            const urls = grokAdapter.buildApiUrls?.(id) ?? [];
            expect(urls.length).toBe(3);
            expect(urls[0]).toContain(`/conversations/${id}/load-responses`);
            expect(urls[1]).toContain(`/conversations/${id}/response-node`);
            expect(urls[2]).toContain(`/conversations_v2/${id}`);
        });

        it('should not provide grok.com fetch candidates for x.com numeric IDs', () => {
            const urls = grokAdapter.buildApiUrls?.('2013295304527827227') ?? [];
            expect(urls).toEqual([]);
        });
    });

    describe('parseInterceptedData - Conversation Data', () => {
        it('should parse valid Grok conversation JSON data from object', () => {
            const result = grokAdapter.parseInterceptedData(
                JSON.stringify(sampleConversation),
                'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId',
            );
            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBeDefined();
            expect(result?.mapping).toBeDefined();
        });

        it('should parse valid Grok conversation JSON data from string', () => {
            const jsonString = JSON.stringify(sampleConversation);
            const result = grokAdapter.parseInterceptedData(
                jsonString,
                'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId',
            );
            expect(result).not.toBeNull();
        });

        it('should return null for invalid data', () => {
            const result = grokAdapter.parseInterceptedData(
                JSON.stringify({ invalid: 'data' }),
                'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId',
            );
            expect(result).toBeNull();
        });

        it('should return null for empty conversation items', () => {
            const emptyData = {
                data: {
                    grok_conversation_items_by_rest_id: {
                        items: [],
                    },
                },
            };
            const result = grokAdapter.parseInterceptedData(
                JSON.stringify(emptyData),
                'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId',
            );
            expect(result).toBeNull();
        });

        it('should extract conversation title from first user message', () => {
            const result = grokAdapter.parseInterceptedData(
                JSON.stringify(sampleConversation),
                'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId',
            );
            expect(result?.title).toBeDefined();
            expect(typeof result?.title).toBe('string');
        });

        it('should create proper message tree structure', () => {
            const result = grokAdapter.parseInterceptedData(
                JSON.stringify(sampleConversation),
                'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId',
            );
            expect(result).not.toBeNull();

            const mapping = result!.mapping;
            expect(Object.keys(mapping).length).toBeGreaterThan(0);

            const rootNode = mapping['grok-root'];
            expect(rootNode).toBeDefined();
            expect(rootNode.parent).toBeNull();
            expect(rootNode.message).toBeNull();
        });

        it('should preserve message metadata', () => {
            const result = grokAdapter.parseInterceptedData(
                JSON.stringify(sampleConversation),
                'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId',
            );
            const nodes = (Object.values(result!.mapping) as MessageNode[]).filter((n) => n.message !== null);

            for (const node of nodes) {
                expect(node.message?.metadata).toBeDefined();
                expect(node.message?.metadata.grok_mode).toBeDefined();
                expect(node.message?.metadata.sender_type).toBeDefined();
            }
        });

        it('should handle messages with thinking content', () => {
            const result = grokAdapter.parseInterceptedData(
                JSON.stringify(sampleConversation),
                'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId',
            );
            const nodes = (Object.values(result!.mapping) as MessageNode[]).filter(
                (n) => n.message?.content.content_type === 'thoughts',
            );

            if (nodes.length > 0) {
                for (const node of nodes) {
                    expect(node.message?.content.thoughts).toBeDefined();
                    expect(Array.isArray(node.message?.content.thoughts)).toBe(true);
                }
            }
        });
    });

    describe('parseInterceptedData - Title Caching', () => {
        it('should parse GrokHistory and cache titles', () => {
            const historyResult = grokAdapter.parseInterceptedData(
                JSON.stringify(sampleHistory),
                'https://x.com/i/api/graphql/test/GrokHistory',
            );
            expect(historyResult).toBeNull();

            const conversationResult = grokAdapter.parseInterceptedData(
                JSON.stringify(sampleConversation),
                'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId',
            );

            expect(conversationResult).not.toBeNull();
            expect(conversationResult?.title).toBeDefined();
        });

        it('should handle GrokHistory as string', () => {
            const historyString = JSON.stringify(sampleHistory);
            const result = grokAdapter.parseInterceptedData(
                historyString,
                'https://x.com/i/api/graphql/test/GrokHistory',
            );
            expect(result).toBeNull();
        });

        it('should handle invalid GrokHistory data gracefully', () => {
            const invalidHistory = { data: { invalid: 'structure' } };
            const result = grokAdapter.parseInterceptedData(
                JSON.stringify(invalidHistory),
                'https://x.com/i/api/graphql/test/GrokHistory',
            );
            expect(result).toBeNull();
        });
    });

    describe('parseInterceptedData - grok.com API', () => {
        it('should handle out-of-order grok.com responses', () => {
            const conversationId = '01cb0729-6455-471d-b33a-124b3de76a29';
            const responseNodes = {
                responseNodes: [
                    { responseId: '7d2229b8-3ea3-464c-986f-eae03362ca3e', sender: 'human' },
                    {
                        responseId: '70bc533c-9bfb-4321-b10f-facaed644858',
                        sender: 'assistant',
                        parentResponseId: '7d2229b8-3ea3-464c-986f-eae03362ca3e',
                    },
                ],
                inflightResponses: [],
            };

            const loadResponses = {
                responses: [
                    {
                        responseId: '7d2229b8-3ea3-464c-986f-eae03362ca3e',
                        message: 'ROLE: Expert',
                        sender: 'human',
                        createTime: '2026-01-26T15:18:04.766Z',
                        partial: false,
                        metadata: {
                            requestModelDetails: {
                                modelId: 'grok-4-1-thinking-1129',
                            },
                        },
                        model: 'grok-4',
                    },
                    {
                        responseId: '70bc533c-9bfb-4321-b10f-facaed644858',
                        message: 'T11127 - How is the combining between his statement',
                        sender: 'assistant',
                        createTime: '2026-01-26T15:19:19.160Z',
                        parentResponseId: '7d2229b8-3ea3-464c-986f-eae03362ca3e',
                        partial: false,
                        metadata: {},
                        model: 'grok-4',
                    },
                ],
            };

            const conversationMeta = {
                conversation: {
                    conversationId: conversationId,
                    title: 'Classical Islamic Text Translation Rules',
                    createTime: '2026-01-26T15:18:04.730551Z',
                    modifyTime: '2026-01-26T15:19:21.015693Z',
                },
            };

            const responseNodeUrl = `https://grok.com/rest/app-chat/conversations/${conversationId}/response-node?includeThreads=true`;
            const loadResponsesUrl = `https://grok.com/rest/app-chat/conversations/${conversationId}/load-responses`;
            const metaUrl = `https://grok.com/rest/app-chat/conversations_v2/${conversationId}?includeWorkspaces=true&includeTaskResult=true`;

            const nodesResult = grokAdapter.parseInterceptedData(JSON.stringify(responseNodes), responseNodeUrl);
            expect(nodesResult).toBeNull();

            const responsesResult = grokAdapter.parseInterceptedData(JSON.stringify(loadResponses), loadResponsesUrl);
            expect(responsesResult).not.toBeNull();
            expect(responsesResult?.conversation_id).toBe(conversationId);
            expect(responsesResult?.default_model_slug).toBe('grok-4');

            const metaResult = grokAdapter.parseInterceptedData(JSON.stringify(conversationMeta), metaUrl);
            expect(metaResult).not.toBeNull();
            expect(metaResult?.title).toBe('Classical Islamic Text Translation Rules');

            const mapping = (metaResult?.mapping ?? {}) as Record<string, MessageNode>;
            const rootNode = Object.values(mapping).find((node) => node.parent === null);
            expect(rootNode).toBeDefined();

            const firstNode = mapping['7d2229b8-3ea3-464c-986f-eae03362ca3e'];
            const secondNode = mapping['70bc533c-9bfb-4321-b10f-facaed644858'];
            expect(firstNode?.parent).toBe(rootNode?.id ?? null);
            expect(secondNode?.parent).toBe(firstNode?.id);
        });

        it('should parse load-responses entries when a line is a single response object', () => {
            const conversationId = '01cb0729-6455-471d-b33a-124b3de76a29';
            const lineObject = {
                responseId: '70bc533c-9bfb-4321-b10f-facaed644858',
                message: 'Single NDJSON response payload',
                sender: 'assistant',
                createTime: '2026-01-26T15:19:19.160Z',
                partial: false,
                metadata: {},
                model: 'grok-4',
            };

            const loadResponsesUrl = `https://grok.com/rest/app-chat/conversations/${conversationId}/load-responses`;
            const result = grokAdapter.parseInterceptedData(JSON.stringify(lineObject), loadResponsesUrl);

            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe(conversationId);
            expect(result?.mapping['70bc533c-9bfb-4321-b10f-facaed644858']?.message).not.toBeNull();
        });
    });

    describe('formatFilename', () => {
        it('should format filename with title and timestamp', () => {
            const data = {
                title: 'Test Grok Conversation',
                create_time: 1768841980.715,
                update_time: 1768841980.715,
                mapping: {},
                conversation_id: '2013295304527827227',
                current_node: 'node-1',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'grok-2',
                safe_urls: [],
                blocked_urls: [],
            };

            const filename = grokAdapter.formatFilename(data);

            expect(filename).toContain('Test_Grok_Conversation');
            expect(filename).toMatch(/\d{4}-\d{2}-\d{2}/);
        });

        it('should sanitize special characters in title', () => {
            const data = {
                title: 'Test: Special/Characters\\Here?',
                create_time: 1768841980.715,
                update_time: 1768841980.715,
                mapping: {},
                conversation_id: '2013295304527827227',
                current_node: 'node-1',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'grok-2',
                safe_urls: [],
                blocked_urls: [],
            };

            const filename = grokAdapter.formatFilename(data);
            expect(filename).not.toMatch(/[:/\\?<>"|*]/);
        });

        it('should handle empty title', () => {
            const data = {
                title: '',
                create_time: 1768841980.715,
                update_time: 1768841980.715,
                mapping: {},
                conversation_id: '2013295304527827227',
                current_node: 'node-1',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'grok-2',
                safe_urls: [],
                blocked_urls: [],
            };

            const filename = grokAdapter.formatFilename(data);
            expect(filename).toContain('grok_conversation');
        });

        it('should truncate very long titles', () => {
            const longTitle = 'A'.repeat(200);
            const data = {
                title: longTitle,
                create_time: 1768841980.715,
                update_time: 1768841980.715,
                mapping: {},
                conversation_id: '2013295304527827227',
                current_node: 'node-1',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'grok-2',
                safe_urls: [],
                blocked_urls: [],
            };

            const filename = grokAdapter.formatFilename(data);
            expect(filename.length).toBeLessThan(150);
        });
    });

    describe('conversation data structure validation', () => {
        it('should have required top-level fields', () => {
            const result = grokAdapter.parseInterceptedData(
                JSON.stringify(sampleConversation),
                'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId',
            );
            expect(result).not.toBeNull();
            expect(typeof result?.title).toBe('string');
            expect(typeof result?.create_time).toBe('number');
            expect(typeof result?.update_time).toBe('number');
            expect(typeof result?.conversation_id).toBe('string');
            expect(typeof result?.mapping).toBe('object');
            expect(typeof result?.current_node).toBe('string');
        });

        it('should have valid message nodes', () => {
            const result = grokAdapter.parseInterceptedData(
                JSON.stringify(sampleConversation),
                'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId',
            );
            expect(result).not.toBeNull();
            const nodes = Object.values(result!.mapping) as MessageNode[];
            expect(nodes.length).toBeGreaterThan(0);

            for (const node of nodes) {
                expect(node.id).toBeDefined();
                expect(Array.isArray(node.children)).toBe(true);
            }
        });

        it('should have messages with correct author roles', () => {
            const result = grokAdapter.parseInterceptedData(
                JSON.stringify(sampleConversation),
                'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId',
            );
            expect(result).not.toBeNull();
            const messagesWithContent = (Object.values(result!.mapping) as MessageNode[]).filter(
                (n): n is any => n.message !== null,
            );

            expect(messagesWithContent.length).toBeGreaterThan(0);

            for (const node of messagesWithContent) {
                expect(['user', 'assistant']).toContain(node.message.author.role);
            }
        });

        it('should have proper tree structure', () => {
            const result = grokAdapter.parseInterceptedData(
                JSON.stringify(sampleConversation),
                'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId',
            );
            expect(result).not.toBeNull();

            // Find root node
            const rootNodes = (Object.values(result!.mapping) as MessageNode[]).filter((n) => n.parent === null);
            expect(rootNodes.length).toBe(1);

            // Verify children point to valid nodes
            for (const node of Object.values(result!.mapping) as MessageNode[]) {
                for (const childId of node.children) {
                    const childNode = result!.mapping[childId];
                    expect(childNode).toBeDefined();
                    expect(childNode.parent).toBe(node.id);
                }
            }
        });

        it('should have current_node pointing to valid node', () => {
            const result = grokAdapter.parseInterceptedData(
                JSON.stringify(sampleConversation),
                'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId',
            );
            expect(result).not.toBeNull();
            expect(result!.mapping[result!.current_node]).toBeDefined();
        });
    });
});

describe('Grok Platform Adapter - ID Synchronization', () => {
    let grokAdapter: any;

    beforeAll(async () => {
        const mod = await import('@/platforms/grok');
        grokAdapter = mod.grokAdapter;
    });

    it('should override conversation ID from URL params when present', () => {
        const urlId = '9999999999999999999';
        const variables = JSON.stringify({ restId: urlId });
        const url = `https://x.com/i/api/graphql/test/GrokConversationItemsByRestId?variables=${encodeURIComponent(variables)}`;

        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), url);

        expect(result).not.toBeNull();
        expect(result?.conversation_id).toBe(urlId);
    });

    it('should fallback to regex extraction when URL variables are not valid JSON', () => {
        const urlId = '8888888888888888888';
        const url = `https://x.com/i/api/graphql/test?variables={%22restId%22%3A%22${urlId}%22, BROKEN_JSON`;

        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), url);

        expect(result).not.toBeNull();
        expect(result?.conversation_id).toBe(urlId);
    });

    it('should use internal conversation ID when no URL restId is present', () => {
        const url = 'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId';

        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), url);

        expect(result).not.toBeNull();
        expect(result?.conversation_id).toBeDefined();
        expect(result?.conversation_id.length).toBeGreaterThan(0);
    });
});
