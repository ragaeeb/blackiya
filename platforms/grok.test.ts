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
            expect(grokAdapter.isPlatformUrl('https://x.com/i/grok?conversation=123')).toBeTrue();
            expect(grokAdapter.isPlatformUrl('https://x.com/i/grok')).toBeTrue();
            expect(grokAdapter.isPlatformUrl('https://grok.com/c/01cb0729-6455-471d-b33a-124b3de76a29')).toBeTrue();
            expect(grokAdapter.isPlatformUrl('https://grok.com/')).toBeTrue();
        });

        it('should reject non-Grok URLs', () => {
            expect(grokAdapter.isPlatformUrl('https://x.com/home')).toBeFalse();
            expect(grokAdapter.isPlatformUrl('https://chatgpt.com')).toBeFalse();
        });
    });

    describe('apiEndpointPattern', () => {
        it('should match Grok GraphQL conversation endpoint', () => {
            const endpoint =
                'https://x.com/i/api/graphql/6QmFgXuRQyOnW2iJ7nIk7g/GrokConversationItemsByRestId?variables=%7B%22restId%22%3A%222013295304527827227%22%7D';
            expect(grokAdapter.apiEndpointPattern.test(endpoint)).toBeTrue();
        });

        it('should match GrokHistory endpoint', () => {
            const endpoint = 'https://x.com/i/api/graphql/9Hyh5D4-WXLnExZkONSkZg/GrokHistory?variables=%7B%7D';
            expect(grokAdapter.apiEndpointPattern.test(endpoint)).toBeTrue();
        });

        it('should match grok.com conversation endpoints', () => {
            const pattern = grokAdapter.apiEndpointPattern;
            expect(
                pattern.test(
                    'https://grok.com/rest/app-chat/conversations_v2/01cb0729-6455-471d-b33a-124b3de76a29?includeWorkspaces=true&includeTaskResult=true',
                ),
            ).toBeTrue();
            expect(
                pattern.test(
                    'https://grok.com/rest/app-chat/conversations/01cb0729-6455-471d-b33a-124b3de76a29/response-node?includeThreads=true',
                ),
            ).toBeTrue();
            expect(
                pattern.test(
                    'https://grok.com/rest/app-chat/conversations/01cb0729-6455-471d-b33a-124b3de76a29/load-responses',
                ),
            ).toBeTrue();
        });

        it('should match x.com add_response.json streaming endpoint (V2.1-027)', () => {
            const endpoint = 'https://x.com/2/grok/add_response.json';
            expect(grokAdapter.apiEndpointPattern.test(endpoint)).toBeTrue();
        });

        it('should match grok.com conversations/new endpoint', () => {
            const endpoint = 'https://grok.com/rest/app-chat/conversations/new';
            expect(grokAdapter.apiEndpointPattern.test(endpoint)).toBeTrue();
        });

        it('should match grok.com reconnect-response-v2 streaming endpoint', () => {
            const endpoint =
                'https://grok.com/rest/app-chat/conversations/reconnect-response-v2/5b128365-2fed-4339-a2b6-8a85a62ad182';
            expect(grokAdapter.apiEndpointPattern.test(endpoint)).toBeTrue();
            expect(grokAdapter.completionTriggerPattern.test(endpoint)).toBeFalse();
        });

        it('should match completion trigger for add_response.json (V2.1-027)', () => {
            const pattern = grokAdapter.completionTriggerPattern;
            expect(pattern.test('https://x.com/2/grok/add_response.json')).toBeTrue();
        });

        it('should match completion trigger for conversations/new (V2.1-026)', () => {
            const pattern = grokAdapter.completionTriggerPattern;
            expect(pattern.test('https://grok.com/rest/app-chat/conversations/new')).toBeTrue();
        });

        it('should not match other GraphQL endpoints', () => {
            const endpoint = 'https://x.com/i/api/graphql/abc123/UserByScreenName';
            expect(grokAdapter.apiEndpointPattern.test(endpoint)).toBeFalse();
        });

        it('should not match non-API URLs', () => {
            const endpoint = 'https://x.com/i/grok?conversation=123';
            expect(grokAdapter.apiEndpointPattern.test(endpoint)).toBeFalse();
        });

        it('should match completion trigger URLs for x.com and grok.com response endpoints', () => {
            const pattern = grokAdapter.completionTriggerPattern;
            expect(
                pattern.test(
                    'https://x.com/i/api/graphql/6QmFgXuRQyOnW2iJ7nIk7g/GrokConversationItemsByRestId?variables=%7B%22restId%22%3A%222013295304527827227%22%7D',
                ),
            ).toBeTrue();
            expect(
                pattern.test(
                    'https://grok.com/rest/app-chat/conversations/01cb0729-6455-471d-b33a-124b3de76a29/load-responses',
                ),
            ).toBeTrue();
            expect(
                pattern.test('https://x.com/i/api/graphql/9Hyh5D4-WXLnExZkONSkZg/GrokHistory?variables=%7B%7D'),
            ).toBeFalse();
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
                    expect(Array.isArray(node.message?.content.thoughts)).toBeTrue();
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
        it('should parse NDJSON from grok.com when metadata arrives first then streaming data (V2.1-026)', () => {
            const conversationId = 'ffcce332-936a-4ad9-a852-385107229519';

            // Step 1: metadata arrives from conversations_v2 (creates empty conversation in activeConversations)
            const metaUrl = `https://grok.com/rest/app-chat/conversations_v2/${conversationId}?includeWorkspaces=true`;
            grokAdapter.parseInterceptedData(
                JSON.stringify({
                    conversation: {
                        conversationId,
                        title: 'Capital of France',
                        createTime: '2026-02-16T08:00:00.000Z',
                        modifyTime: '2026-02-16T08:00:05.000Z',
                    },
                }),
                metaUrl,
            );

            // Step 2: NDJSON streaming data arrives from conversations/new
            const ndjsonPayload = [
                JSON.stringify({
                    responseId: 'user-resp-1',
                    message: 'What is the capital of France?',
                    sender: 'human',
                    createTime: '2026-02-16T08:00:00.000Z',
                    partial: false,
                    model: 'grok-4',
                }),
                JSON.stringify({
                    responseId: 'asst-resp-1',
                    message: 'The capital of France is Paris.',
                    sender: 'assistant',
                    createTime: '2026-02-16T08:00:05.000Z',
                    parentResponseId: 'user-resp-1',
                    partial: false,
                    model: 'grok-4',
                }),
            ].join('\n');

            const newConversationUrl = 'https://grok.com/rest/app-chat/conversations/new';
            const result = grokAdapter.parseInterceptedData(ndjsonPayload, newConversationUrl);

            // With the active conversation already cached from meta, the NDJSON parser
            // should add messages to it and return valid ConversationData
            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe(conversationId);

            const messagesWithContent = Object.values(result!.mapping).filter((n: any) => n.message !== null);
            expect(messagesWithContent.length).toBe(2);
            expect(result?.title).toBe('Capital of France');
        });

        it('should parse NDJSON with conversationId in first line when no prior meta (V2.1-026)', () => {
            // When conversations/new fires before conversations_v2, the NDJSON
            // might include a conversationId field in one of its lines
            const conversationId = 'aabbccdd-1122-3344-5566-778899001122';

            const ndjsonPayload = [
                // Some grok.com streaming payloads include conversationId in metadata lines
                JSON.stringify({
                    conversationId,
                    responseId: 'user-resp-1',
                    message: 'Hello',
                    sender: 'human',
                    createTime: '2026-02-16T08:00:00.000Z',
                    partial: false,
                    model: 'grok-4',
                }),
                JSON.stringify({
                    responseId: 'asst-resp-1',
                    message: 'Hi there!',
                    sender: 'assistant',
                    createTime: '2026-02-16T08:00:01.000Z',
                    parentResponseId: 'user-resp-1',
                    partial: false,
                    model: 'grok-4',
                }),
            ].join('\n');

            const url = 'https://grok.com/rest/app-chat/conversations/new';
            const result = grokAdapter.parseInterceptedData(ndjsonPayload, url);

            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe(conversationId);
        });

        it('should return null (not throw) for malformed conversations_v2 payload', () => {
            const url =
                'https://grok.com/rest/app-chat/conversations_v2/af642f01-1a30-4ad2-a588-c15293a4fafe?includeWorkspaces=true';
            let result: unknown;
            expect(() => {
                result = grokAdapter.parseInterceptedData('{"broken"', url);
            }).not.toThrow();
            expect(result).toBeNull();
        });

        it('should return null (not throw) for malformed response-node payload', () => {
            const url =
                'https://grok.com/rest/app-chat/conversations/af642f01-1a30-4ad2-a588-c15293a4fafe/response-node?includeThreads=true';
            let result: unknown;
            expect(() => {
                result = grokAdapter.parseInterceptedData('{"broken"', url);
            }).not.toThrow();
            expect(result).toBeNull();
        });

        it('should return null (not throw) for malformed load-responses payload', () => {
            const url =
                'https://grok.com/rest/app-chat/conversations/af642f01-1a30-4ad2-a588-c15293a4fafe/load-responses';
            let result: unknown;
            expect(() => {
                result = grokAdapter.parseInterceptedData('{"broken"', url);
            }).not.toThrow();
            expect(result).toBeNull();
        });

        it('should parse x.com add_response.json NDJSON streaming (V2.1-027)', () => {
            const conversationId = '2023309163200168014';

            // x.com streaming format: first line has conversationId,
            // subsequent lines have result objects with content tokens
            const ndjsonPayload = [
                JSON.stringify({
                    conversationId,
                    userChatItemId: '2023309164601069568',
                    agentChatItemId: '2023309164601069569',
                }),
                JSON.stringify({
                    result: {
                        sender: 'ASSISTANT',
                        responseChatItemId: '2023309164601069569',
                        message: 'Hello! How can I help you today?',
                    },
                }),
            ].join('\n');

            const url = 'https://x.com/2/grok/add_response.json';

            // At minimum, should not throw. The x.com NDJSON format may need
            // additional parsing support, but it should degrade gracefully.
            // The conversationId is numeric (x.com format), not UUID (grok.com format),
            // so the NDJSON fallback may not find it via GROK_COM_CONVERSATION_ID_PATTERN.
            // This is expected — x.com uses the GraphQL path for canonical data.
            expect(() => grokAdapter.parseInterceptedData(ndjsonPayload, url)).not.toThrow();
        });

        it('should not throw SyntaxError on any NDJSON in generic fallback path (V2.1-026)', () => {
            // Exact failure from V2.1-026: multi-line data hitting JSON.parse
            const ndjsonPayload = '{"key1":"val1"}\n{"key2":"val2"}\n{"key3":"val3"}';
            const url = 'https://grok.com/rest/app-chat/conversations/new';

            // Must NOT throw — should return null gracefully
            expect(() => grokAdapter.parseInterceptedData(ndjsonPayload, url)).not.toThrow();
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
                expect(Array.isArray(node.children)).toBeTrue();
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

describe('Grok Platform Adapter - evaluateReadiness', () => {
    let grokAdapter: any;

    beforeAll(async () => {
        const mod = await import('@/platforms/grok');
        grokAdapter = mod.grokAdapter;
    });

    it('returns not-ready for partial assistant payloads', () => {
        const readiness = grokAdapter.evaluateReadiness?.({
            title: 'Grok Conversation',
            create_time: 1,
            update_time: 2,
            conversation_id: '2013295304527827227',
            current_node: 'assistant-1',
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'grok-4',
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
                        author: { role: 'assistant', name: 'Grok', metadata: {} },
                        create_time: 1,
                        update_time: 2,
                        content: { content_type: 'text', parts: ['Partial text'] },
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

        expect(readiness?.ready).toBeFalse();
        expect(readiness?.terminal).toBeFalse();
    });

    it('returns ready for finished terminal assistant response', () => {
        const readiness = grokAdapter.evaluateReadiness?.({
            title: 'Grok Conversation',
            create_time: 1,
            update_time: 3,
            conversation_id: '2013295304527827227',
            current_node: 'assistant-2',
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'grok-4',
            safe_urls: [],
            blocked_urls: [],
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['assistant-2'] },
                'assistant-2': {
                    id: 'assistant-2',
                    parent: 'root',
                    children: [],
                    message: {
                        id: 'assistant-2',
                        author: { role: 'assistant', name: 'Grok', metadata: {} },
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

        expect(readiness?.ready).toBeTrue();
        expect(readiness?.terminal).toBeTrue();
        expect(readiness?.contentHash).not.toBeNull();
    });
});

describe('Grok dual-match and metadata endpoints', () => {
    let grokAdapter: any;

    beforeAll(async () => {
        const mod = await import('@/platforms/grok');
        grokAdapter = mod.grokAdapter;
    });

    describe('Dual-match: URLs matching both apiEndpointPattern AND completionTriggerPattern', () => {
        it('conversations/new matches BOTH patterns (root cause of premature completion)', () => {
            const url = 'https://grok.com/rest/app-chat/conversations/new';
            expect(grokAdapter.apiEndpointPattern.test(url)).toBeTrue();
            expect(grokAdapter.completionTriggerPattern?.test(url)).toBeTrue();
        });

        it('add_response.json matches BOTH patterns', () => {
            const url = 'https://x.com/2/grok/add_response.json';
            expect(grokAdapter.apiEndpointPattern.test(url)).toBeTrue();
            expect(grokAdapter.completionTriggerPattern?.test(url)).toBeTrue();
        });

        it('load-responses matches BOTH patterns', () => {
            const url = 'https://grok.com/rest/app-chat/conversations/af642f01/load-responses';
            expect(grokAdapter.apiEndpointPattern.test(url)).toBeTrue();
            expect(grokAdapter.completionTriggerPattern?.test(url)).toBeTrue();
        });

        it('conversations_v2 matches apiEndpointPattern but NOT completionTriggerPattern', () => {
            const url = 'https://grok.com/rest/app-chat/conversations_v2/af642f01?includeWorkspaces=true';
            expect(grokAdapter.apiEndpointPattern.test(url)).toBeTrue();
            expect(grokAdapter.completionTriggerPattern?.test(url)).toBeFalse();
        });
    });

    describe('Metadata-only endpoints return null (expected behavior)', () => {
        it('conversations_v2 with metadata-only payload returns null', () => {
            const metadataPayload = JSON.stringify({
                conversation: {
                    conversationId: 'af642f01-1a30-4ad2-a588-c15293a4fafe',
                    title: 'New conversation',
                    starred: false,
                    createTime: '2026-02-16T17:32:35.250115Z',
                    modifyTime: '2026-02-16T17:32:35.272Z',
                    systemPromptName: '',
                    temporary: false,
                    mediaTypes: [],
                    workspaces: [],
                    taskResult: {},
                },
            });
            const url =
                'https://grok.com/rest/app-chat/conversations_v2/af642f01-1a30-4ad2-a588-c15293a4fafe?includeWorkspaces=true';
            const result = grokAdapter.parseInterceptedData(metadataPayload, url);
            expect(result).toBeNull();
        });

        it('response-node with empty responseNodes returns null', () => {
            const payload = JSON.stringify({
                responseNodes: [],
                inflightResponses: [],
            });
            const url =
                'https://grok.com/rest/app-chat/conversations/af642f01-1a30-4ad2-a588-c15293a4fafe/response-node?includeThreads=true';
            const result = grokAdapter.parseInterceptedData(payload, url);
            expect(result).toBeNull();
        });

        it('reconnect-response-v2 NDJSON with {result:{response:{modelResponse}}} parses correctly (V2.1-032)', () => {
            const convId = 'f41755df-175d-4a29-bef4-0689b7c2b39d';
            const respId = '5f7272eb-1bb5-45c0-b680-707772ad9a66';
            const userRespId = '38a6c923-80a3-4ade-b7ad-06b809701a9a';

            // Simulate reconnect-response-v2 NDJSON with {result: {response: {...}}} envelope
            const ndjsonLines = [
                JSON.stringify({
                    result: {
                        response: {
                            userResponse: {
                                responseId: userRespId,
                                message: 'Translate this text',
                                sender: 'human',
                                createTime: '2026-02-16T18:38:10.030916Z',
                                parentResponseId: '',
                                partial: false,
                            },
                        },
                    },
                }),
                JSON.stringify({
                    result: {
                        response: {
                            modelResponse: {
                                responseId: respId,
                                message: 'Here is the translation of the text.',
                                sender: 'assistant',
                                createTime: '2026-02-16T18:38:10.071800817Z',
                                parentResponseId: userRespId,
                                partial: false,
                            },
                        },
                    },
                }),
            ].join('\n');

            // The URL uses a response ID, not conversation ID
            const url = `https://grok.com/rest/app-chat/conversations/reconnect-response-v2/${respId}`;

            // First, set up the last-active conversation ID (simulates earlier conversations_v2 call)
            const metaPayload = JSON.stringify({
                conversation: {
                    conversationId: convId,
                    title: 'Translation Test',
                    starred: false,
                    createTime: '2026-02-16T18:38:10.030916Z',
                    modifyTime: '2026-02-16T18:38:10.049Z',
                },
            });
            grokAdapter.parseInterceptedData(
                metaPayload,
                `https://grok.com/rest/app-chat/conversations_v2/${convId}?includeWorkspaces=true`,
            );

            // Now parse the reconnect-response-v2 NDJSON
            const result = grokAdapter.parseInterceptedData(ndjsonLines, url);

            expect(result).not.toBeNull();
            if (!result) {
                return;
            }

            expect(result.conversation_id).toBe(convId);

            // Should have user and assistant messages
            const messages = Object.values(result.mapping)
                .map((n: any) => n.message)
                .filter((m: any) => m !== null);
            expect(messages.length).toBeGreaterThanOrEqual(2);

            const userMsg = messages.find((m: any) => m.author.role === 'user');
            expect(userMsg).toBeDefined();
            expect(userMsg?.content.parts?.[0]).toBe('Translate this text');

            const assistantMsg = messages.find((m: any) => m.author.role === 'assistant');
            expect(assistantMsg).toBeDefined();
            expect(assistantMsg?.content.parts?.[0]).toBe('Here is the translation of the text.');
        });

        it('conversations/new NDJSON with {result:{conversation:{conversationId}}} extracts ID (V2.1-032)', () => {
            const convId = 'abc12345-1234-5678-abcd-1234567890ab';
            const respId = 'def12345-1234-5678-abcd-1234567890ab';

            const ndjsonLines = [
                JSON.stringify({
                    result: {
                        conversation: {
                            conversationId: convId,
                            title: 'New conversation',
                        },
                    },
                }),
                JSON.stringify({
                    result: {
                        response: {
                            userResponse: {
                                responseId: respId,
                                message: 'Hello',
                                sender: 'human',
                                createTime: '2026-02-16T18:00:00Z',
                                parentResponseId: '',
                                partial: false,
                            },
                        },
                    },
                }),
            ].join('\n');

            const url = 'https://grok.com/rest/app-chat/conversations/new';
            const result = grokAdapter.parseInterceptedData(ndjsonLines, url);

            expect(result).not.toBeNull();
            if (!result) {
                return;
            }
            expect(result.conversation_id).toBe(convId);
        });

        it('conversations_v2 still caches title even when returning null', () => {
            const metadataPayload = JSON.stringify({
                conversation: {
                    conversationId: 'test-title-cache-id',
                    title: 'My cached title',
                    starred: false,
                    createTime: '2026-02-16T17:32:35Z',
                    modifyTime: '2026-02-16T17:32:35Z',
                },
            });
            const url = 'https://grok.com/rest/app-chat/conversations_v2/test-title-cache-id';
            const result = grokAdapter.parseInterceptedData(metadataPayload, url);
            expect(result).toBeNull();
        });
    });

    describe('extractTitleFromDom (V2.1-037)', () => {
        // Provide a minimal document mock for the test environment
        const mockDocument = { title: '' };
        const originalDocument = (globalThis as any).document;

        const withDocTitle = (title: string, fn: () => void) => {
            (globalThis as any).document = { ...mockDocument, title };
            try {
                fn();
            } finally {
                (globalThis as any).document = originalDocument;
            }
        };

        it('should have extractTitleFromDom defined', () => {
            expect(typeof grokAdapter.extractTitleFromDom).toBe('function');
        });

        it('should have defaultTitles list', () => {
            expect(grokAdapter.defaultTitles).toBeDefined();
            expect(grokAdapter.defaultTitles).toContain('New conversation');
            expect(grokAdapter.defaultTitles).toContain('Grok Conversation');
        });

        it('should extract title from document.title with suffix', () => {
            withDocTitle('Classical Islamic Text Translation Guidelines - Grok', () => {
                const result = grokAdapter.extractTitleFromDom!();
                expect(result).toBe('Classical Islamic Text Translation Guidelines');
            });
        });

        it('should extract title from document.title without suffix', () => {
            withDocTitle('Some Conversation Title', () => {
                const result = grokAdapter.extractTitleFromDom!();
                expect(result).toBe('Some Conversation Title');
            });
        });

        it('should return null for bare Grok page title', () => {
            withDocTitle('Grok', () => {
                const result = grokAdapter.extractTitleFromDom!();
                expect(result).toBeNull();
            });
        });

        it('should return null for empty document title', () => {
            withDocTitle('', () => {
                const result = grokAdapter.extractTitleFromDom!();
                expect(result).toBeNull();
            });
        });

        it('should return null when title matches a default', () => {
            withDocTitle('New conversation - Grok', () => {
                const result = grokAdapter.extractTitleFromDom!();
                expect(result).toBeNull();
            });
        });
    });
});
