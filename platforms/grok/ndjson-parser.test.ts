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

const hasMessageNode = (node: MessageNode): node is MessageNode & { message: NonNullable<MessageNode['message']> } =>
    node.message !== null;

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

describe('Grok Adapter — NDJSON streaming parsing', () => {
    describe('conversations/new (V2.1-026)', () => {
        it('should parse NDJSON from conversations/new when metadata arrives first (V2.1-026)', () => {
            const conversationId = 'ffcce332-936a-4ad9-a852-385107229519';

            // Step 1: metadata via conversations_v2 seeds the active conversation
            grokAdapter.parseInterceptedData(
                JSON.stringify({
                    conversation: {
                        conversationId,
                        title: 'Capital of France',
                        createTime: '2026-02-16T08:00:00.000Z',
                        modifyTime: '2026-02-16T08:00:05.000Z',
                    },
                }),
                `https://grok.com/rest/app-chat/conversations_v2/${conversationId}?includeWorkspaces=true`,
            );

            // Step 2: NDJSON streaming data
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

            const result = grokAdapter.parseInterceptedData(
                ndjsonPayload,
                'https://grok.com/rest/app-chat/conversations/new',
            );
            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe(conversationId);
            expect((Object.values(result!.mapping) as MessageNode[]).filter(hasMessageNode).length).toBe(2);
            expect(result?.title).toBe('Capital of France');
        });

        it('should parse NDJSON with conversationId embedded in payload when no prior meta (V2.1-026)', () => {
            const conversationId = 'aabbccdd-1122-3344-5566-778899001122';
            const ndjsonPayload = [
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

            const result = grokAdapter.parseInterceptedData(
                ndjsonPayload,
                'https://grok.com/rest/app-chat/conversations/new',
            );
            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe(conversationId);
        });

        it('should not throw SyntaxError on multi-line NDJSON in generic fallback path (V2.1-026)', () => {
            const ndjsonPayload = '{"key1":"val1"}\n{"key2":"val2"}\n{"key3":"val3"}';
            expect(() =>
                grokAdapter.parseInterceptedData(ndjsonPayload, 'https://grok.com/rest/app-chat/conversations/new'),
            ).not.toThrow();
        });

        it('should extract conversationId from result.conversation.conversationId field (V2.1-032)', () => {
            const convId = 'abc12345-1234-5678-abcd-1234567890ab';
            const respId = 'def12345-1234-5678-abcd-1234567890ab';
            const ndjsonLines = [
                JSON.stringify({ result: { conversation: { conversationId: convId, title: 'New conversation' } } }),
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

            const result = grokAdapter.parseInterceptedData(
                ndjsonLines,
                'https://grok.com/rest/app-chat/conversations/new',
            );
            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe(convId);
        });
    });

    describe('reconnect-response-v2 (V2.1-032)', () => {
        it('should parse {result:{response:{modelResponse/userResponse}}} envelope', () => {
            const convId = 'f41755df-175d-4a29-bef4-0689b7c2b39d';
            const respId = '5f7272eb-1bb5-45c0-b680-707772ad9a66';
            const userRespId = '38a6c923-80a3-4ade-b7ad-06b809701a9a';

            // Seed last-active conversation ID via meta
            grokAdapter.parseInterceptedData(
                JSON.stringify({
                    conversation: {
                        conversationId: convId,
                        title: 'Translation Test',
                        starred: false,
                        createTime: '2026-02-16T18:38:10Z',
                        modifyTime: '2026-02-16T18:38:10Z',
                    },
                }),
                `https://grok.com/rest/app-chat/conversations_v2/${convId}?includeWorkspaces=true`,
            );

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

            const result = grokAdapter.parseInterceptedData(
                ndjsonLines,
                `https://grok.com/rest/app-chat/conversations/reconnect-response-v2/${respId}`,
            );
            expect(result).not.toBeNull();
            expect(result!.conversation_id).toBe(convId);

            const messages = Object.values(result!.mapping)
                .map((n: any) => n.message)
                .filter((m: any) => m !== null);
            expect(messages.length).toBeGreaterThanOrEqual(2);

            const userMsg = messages.find((m: any) => m.author.role === 'user');
            expect(userMsg?.content.parts?.[0]).toBe('Translate this text');

            const assistantMsg = messages.find((m: any) => m.author.role === 'assistant');
            expect(assistantMsg?.content.parts?.[0]).toBe('Here is the translation of the text.');
        });
    });

    describe('x.com add_response.json (V2.1-027)', () => {
        it('should parse add_response NDJSON for x.com numeric IDs and preserve thinking text', () => {
            const conversationId = '2023309163200168014';
            const ndjsonPayload = [
                JSON.stringify({
                    conversationId,
                    userChatItemId: '2023309164601069568',
                    agentChatItemId: '2023309164601069569',
                }),
                JSON.stringify({
                    result: {
                        sender: 'assistant',
                        responseChatItemId: '2023309164601069569',
                        message: 'Thinking about translation constraints',
                        isThinking: true,
                        messageTag: 'header',
                    },
                }),
                JSON.stringify({
                    result: {
                        sender: 'assistant',
                        responseChatItemId: '2023309164601069569',
                        message: '- Waqf requires permanent benefit from a specific, enduring asset.\n',
                        isThinking: true,
                        messageTag: 'summary',
                    },
                }),
                JSON.stringify({
                    result: {
                        sender: 'assistant',
                        responseChatItemId: '2023309164601069569',
                        message: 'Hello',
                        isThinking: false,
                        messageTag: 'final',
                    },
                }),
                JSON.stringify({
                    result: {
                        sender: 'assistant',
                        responseChatItemId: '2023309164601069569',
                        message: ' world',
                        isThinking: false,
                        messageTag: 'final',
                    },
                }),
                JSON.stringify({
                    result: {
                        sender: 'assistant',
                        responseChatItemId: '2023309164601069569',
                        isSoftStop: true,
                        uiLayout: { steerModelId: 'grok-3' },
                    },
                }),
            ].join('\n');

            const result = grokAdapter.parseInterceptedData(ndjsonPayload, 'https://x.com/2/grok/add_response.json');
            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe(conversationId);
            expect(result?.current_node).toBe('2023309164601069569');
            expect(result?.default_model_slug).toBe('grok-3');

            const assistantNode = result?.mapping['2023309164601069569'];
            expect(assistantNode?.message?.content?.parts?.[0]).toBe('Hello world');
            const thoughts = (assistantNode?.message?.content as any)?.thoughts ?? [];
            expect(Array.isArray(thoughts)).toBeTrue();
            expect(thoughts.length).toBeGreaterThan(0);
            expect(
                (thoughts as Array<{ content?: string }>).some((t) => t.content?.includes('Waqf requires permanent')),
            ).toBeTrue();
        });

        it('should match add_response.json in both apiEndpointPattern and completionTriggerPattern', () => {
            const url = 'https://x.com/2/grok/add_response.json';
            expect(grokAdapter.apiEndpointPattern.test(url)).toBeTrue();
            expect(grokAdapter.completionTriggerPattern.test(url)).toBeTrue();
        });

        it('should match grok.x.com add_response.json in both apiEndpointPattern and completionTriggerPattern', () => {
            const url = 'https://grok.x.com/2/grok/add_response.json';
            expect(grokAdapter.apiEndpointPattern.test(url)).toBeTrue();
            expect(grokAdapter.completionTriggerPattern.test(url)).toBeTrue();
        });
    });
});
