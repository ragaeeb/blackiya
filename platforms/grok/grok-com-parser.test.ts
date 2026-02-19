import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('wxt/browser', () => ({
    browser: {
        storage: { local: { get: async () => ({}), set: async () => {} } },
        runtime: { getURL: () => 'chrome-extension://mock/' },
    },
}));
mock.module('@/utils/logger', () => ({
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import type { MessageNode } from '@/utils/types';

let grokAdapter: any;
let resetGrokAdapterState: (() => void) | null = null;

beforeAll(async () => {
    const mod = await import('@/platforms/grok');
    grokAdapter = mod.grokAdapter;
    resetGrokAdapterState = mod.resetGrokAdapterState ?? null;
});

beforeEach(() => {
    resetGrokAdapterState?.();
});

const CONV_ID = '01cb0729-6455-471d-b33a-124b3de76a29';
const META_URL = `https://grok.com/rest/app-chat/conversations_v2/${CONV_ID}?includeWorkspaces=true&includeTaskResult=true`;
const RESPONSE_NODE_URL = `https://grok.com/rest/app-chat/conversations/${CONV_ID}/response-node?includeThreads=true`;
const LOAD_RESPONSES_URL = `https://grok.com/rest/app-chat/conversations/${CONV_ID}/load-responses`;

describe('Grok Adapter — grok.com REST parsing', () => {
    describe('out-of-order API responses (response-node → load-responses → meta)', () => {
        it('should handle out-of-order grok.com responses and build the correct tree', () => {
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
                        model: 'grok-4',
                    },
                    {
                        responseId: '70bc533c-9bfb-4321-b10f-facaed644858',
                        message: 'T11127 - How is the combining',
                        sender: 'assistant',
                        createTime: '2026-01-26T15:19:19.160Z',
                        parentResponseId: '7d2229b8-3ea3-464c-986f-eae03362ca3e',
                        partial: false,
                        model: 'grok-4',
                    },
                ],
            };
            const conversationMeta = {
                conversation: {
                    conversationId: CONV_ID,
                    title: 'Classical Islamic Text Translation Rules',
                    createTime: '2026-01-26T15:18:04.730551Z',
                    modifyTime: '2026-01-26T15:19:21.015693Z',
                },
            };

            // response-node: no messages yet — should be null
            const nodesResult = grokAdapter.parseInterceptedData(JSON.stringify(responseNodes), RESPONSE_NODE_URL);
            expect(nodesResult).toBeNull();

            // load-responses: messages arrive — should have conversation
            const responsesResult = grokAdapter.parseInterceptedData(JSON.stringify(loadResponses), LOAD_RESPONSES_URL);
            expect(responsesResult).not.toBeNull();
            expect(responsesResult?.conversation_id).toBe(CONV_ID);
            expect(responsesResult?.default_model_slug).toBe('grok-4');

            // meta: returns enriched conversation with title
            const metaResult = grokAdapter.parseInterceptedData(JSON.stringify(conversationMeta), META_URL);
            expect(metaResult).not.toBeNull();
            expect(metaResult?.title).toBe('Classical Islamic Text Translation Rules');

            // Validate tree structure
            const mapping = metaResult?.mapping as Record<string, MessageNode>;
            const rootNode = Object.values(mapping).find((node) => node.parent === null);
            expect(rootNode).toBeDefined();

            const firstNode = mapping['7d2229b8-3ea3-464c-986f-eae03362ca3e'];
            const secondNode = mapping['70bc533c-9bfb-4321-b10f-facaed644858'];
            expect(firstNode?.parent).toBe(rootNode?.id ?? null);
            expect(secondNode?.parent).toBe(firstNode?.id);
        });
    });

    describe('load-responses parsing', () => {
        it('should parse a single response object (not wrapped in responses array)', () => {
            const lineObject = {
                responseId: '70bc533c-9bfb-4321-b10f-facaed644858',
                message: 'Single NDJSON response payload',
                sender: 'assistant',
                createTime: '2026-01-26T15:19:19.160Z',
                partial: false,
                model: 'grok-4',
            };
            const result = grokAdapter.parseInterceptedData(JSON.stringify(lineObject), LOAD_RESPONSES_URL);
            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe(CONV_ID);
            expect(result?.mapping['70bc533c-9bfb-4321-b10f-facaed644858']?.message).not.toBeNull();
        });

        it('should return null (not throw) for malformed load-responses payload', () => {
            let result: unknown;
            expect(() => {
                result = grokAdapter.parseInterceptedData('{"broken"', LOAD_RESPONSES_URL);
            }).not.toThrow();
            expect(result).toBeNull();
        });
    });

    describe('conversations_v2 metadata endpoint', () => {
        it('should return null for metadata-only payload (no messages yet)', () => {
            const metadataPayload = JSON.stringify({
                conversation: {
                    conversationId: 'af642f01-1a30-4ad2-a588-c15293a4fafe',
                    title: 'New conversation',
                    starred: false,
                    createTime: '2026-02-16T17:32:35Z',
                    modifyTime: '2026-02-16T17:32:35Z',
                },
            });
            const url =
                'https://grok.com/rest/app-chat/conversations_v2/af642f01-1a30-4ad2-a588-c15293a4fafe?includeWorkspaces=true';
            expect(grokAdapter.parseInterceptedData(metadataPayload, url)).toBeNull();
        });

        it('should cache title from conversations_v2 even when returning null', () => {
            const conversationId = 'af642f01-1a30-4ad2-a588-c15293a4fafe';
            const metadataPayload = JSON.stringify({
                conversation: {
                    conversationId,
                    title: 'My cached title',
                    starred: false,
                    createTime: '2026-02-16T17:32:35Z',
                    modifyTime: '2026-02-16T17:32:35Z',
                },
            });
            const metaUrl = `https://grok.com/rest/app-chat/conversations_v2/${conversationId}`;
            const result = grokAdapter.parseInterceptedData(metadataPayload, metaUrl);
            expect(result).toBeNull();

            // When messages arrive, title should come from the cache
            const loadResponsesUrl = `https://grok.com/rest/app-chat/conversations/${conversationId}/load-responses`;
            const loadResponsesPayload = JSON.stringify({
                responses: [
                    {
                        responseId: 'cached-title-test-resp',
                        message: 'Assistant response',
                        sender: 'assistant',
                        createTime: '2026-02-16T17:32:36Z',
                        partial: false,
                        model: 'grok-4',
                    },
                ],
            });
            const followup = grokAdapter.parseInterceptedData(loadResponsesPayload, loadResponsesUrl);
            expect(followup).not.toBeNull();
            expect(followup?.conversation_id).toBe(conversationId);
            expect(followup?.title).toBe('My cached title');
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
    });

    describe('response-node endpoint', () => {
        it('should return null for empty responseNodes', () => {
            const payload = JSON.stringify({ responseNodes: [], inflightResponses: [] });
            const url =
                'https://grok.com/rest/app-chat/conversations/af642f01-1a30-4ad2-a588-c15293a4fafe/response-node?includeThreads=true';
            expect(grokAdapter.parseInterceptedData(payload, url)).toBeNull();
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
    });
});
