/**
 * ChatGPT parseInterceptedData tests
 *
 * Covers JSON object parsing (direct + wrapped envelopes) and SSE stream parsing.
 */

import { beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('@/utils/logger', () => ({
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, setLevel: () => {} },
}));

const VALID_ID = '696bc3d5-fa84-8328-b209-4d65cb229e59';
const BACKEND_API_URL = 'https://chatgpt.com/backend-api/f/conversation';

const minimalMapping = () => ({
    root: { id: 'root', message: null, parent: null, children: [] },
});

const rawMessage = (
    id: string,
    role: 'user' | 'assistant',
    content: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
) => ({
    id,
    author: { role, name: null, metadata: {} },
    create_time: 1,
    update_time: 1,
    content,
    status: 'finished_successfully',
    end_turn: role === 'assistant',
    weight: 1,
    metadata: {},
    recipient: 'all',
    channel: null,
    ...overrides,
});

describe('ChatGPT parseInterceptedData', () => {
    let adapter: any;

    beforeAll(async () => {
        const module = await import('@/platforms/chatgpt');
        adapter = module.createChatGPTAdapter();
    });

    // JSON object parsing

    describe('direct JSON payloads', () => {
        it('should parse a flat conversation payload', () => {
            const result = adapter.parseInterceptedData(
                JSON.stringify({ title: 'Test', conversation_id: VALID_ID, mapping: { 'node-1': {} } }),
                'url',
            );
            expect(result).not.toBeNull();
            expect(result.title).toBe('Test');
        });

        it('should normalize `id` to `conversation_id` when needed', () => {
            const result = adapter.parseInterceptedData(
                JSON.stringify({ id: VALID_ID, mapping: { 'node-1': {} } }),
                'url',
            );
            expect(result?.conversation_id).toBe(VALID_ID);
        });

        it('should unwrap { conversation: { ... } } envelope', () => {
            const result = adapter.parseInterceptedData(
                JSON.stringify({
                    conversation: { title: 'Wrapped', conversation_id: VALID_ID, mapping: { 'node-1': {} } },
                }),
                'url',
            );
            expect(result?.title).toBe('Wrapped');
            expect(result?.conversation_id).toBe(VALID_ID);
        });

        it('should unwrap nested { data: { conversation: { ... } } } envelope', () => {
            const result = adapter.parseInterceptedData(
                JSON.stringify({
                    data: {
                        conversation: {
                            title: 'Nested',
                            conversation_id: VALID_ID,
                            mapping: minimalMapping(),
                        },
                    },
                }),
                'url',
            );
            expect(result?.title).toBe('Nested');
        });

        it('should return null when conversation_id is not a valid UUID', () => {
            const result = adapter.parseInterceptedData(
                JSON.stringify({ title: 'Bad', conversation_id: 'not-a-uuid', mapping: minimalMapping() }),
                'url',
            );
            expect(result).toBeNull();
        });

        it('should return null for unrecognised payload shape', () => {
            expect(adapter.parseInterceptedData(JSON.stringify({ foo: 'bar' }), 'url')).toBeNull();
        });

        it('should return null when parse path throws unexpectedly', () => {
            const throwingPayload = {
                get conversation() {
                    throw new Error('boom');
                },
            };
            expect(adapter.parseInterceptedData(throwingPayload, 'url')).toBeNull();
        });

        it('should normalize missing title to empty string', () => {
            const result = adapter.parseInterceptedData(
                JSON.stringify({ conversation_id: VALID_ID, mapping: minimalMapping(), current_node: 'root' }),
                'url',
            );
            expect(result?.title).toBe('');
        });

        it('should preserve a branched history with reasoning and report its active turn ready', () => {
            const payload = {
                title: 'Ushman handoff',
                conversation_id: VALID_ID,
                current_node: 'final-assistant',
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['initial-user'] },
                    'initial-user': {
                        id: 'initial-user',
                        parent: 'root',
                        children: ['initial-assistant'],
                        message: rawMessage('initial-user', 'user', {
                            content_type: 'text',
                            parts: ['You are taking over this chat from a previous session'],
                        }),
                    },
                    'initial-assistant': {
                        id: 'initial-assistant',
                        parent: 'initial-user',
                        children: ['latest-user'],
                        message: rawMessage('initial-assistant', 'assistant', {
                            content_type: 'text',
                            parts: ['Ushman is a software recovery factory for difficult migrations.'],
                        }),
                    },
                    'latest-user': {
                        id: 'latest-user',
                        parent: 'initial-assistant',
                        children: ['reasoning-explain', 'abandoned-branch'],
                        message: rawMessage('latest-user', 'user', {
                            content_type: 'text',
                            parts: ['Use citations but try to keep them minimal'],
                        }),
                    },
                    'reasoning-explain': {
                        id: 'reasoning-explain',
                        parent: 'latest-user',
                        children: ['reasoning-citations'],
                        message: rawMessage(
                            'reasoning-explain',
                            'assistant',
                            {
                                content_type: 'thoughts',
                                thoughts: [
                                    {
                                        summary: 'Evaluating how to explain Ushman to a non-technical audience',
                                        content: 'Planning the explanation.',
                                        chunks: [],
                                        finished: true,
                                    },
                                ],
                            },
                            { end_turn: false },
                        ),
                    },
                    'reasoning-citations': {
                        id: 'reasoning-citations',
                        parent: 'reasoning-explain',
                        children: ['final-assistant'],
                        message: rawMessage(
                            'reasoning-citations',
                            'assistant',
                            {
                                content_type: 'thoughts',
                                thoughts: [
                                    {
                                        summary: 'Analyzing file output and citations',
                                        content: 'Checking cited material.',
                                        chunks: [],
                                        finished: true,
                                    },
                                ],
                            },
                            { end_turn: false },
                        ),
                    },
                    'final-assistant': {
                        id: 'final-assistant',
                        parent: 'reasoning-citations',
                        children: [],
                        message: rawMessage('final-assistant', 'assistant', {
                            content_type: 'text',
                            parts: ['Your Antigravity conclusion can be stronger with a clearer outcome.'],
                        }),
                    },
                    'abandoned-branch': {
                        id: 'abandoned-branch',
                        parent: 'latest-user',
                        children: [],
                        message: rawMessage(
                            'abandoned-branch',
                            'assistant',
                            { content_type: 'text', parts: ['Abandoned draft'] },
                            { status: 'in_progress', end_turn: false },
                        ),
                    },
                },
            };

            const result = adapter.parseInterceptedData(JSON.stringify(payload), BACKEND_API_URL);
            const readiness = adapter.evaluateReadiness(result);
            const exported = JSON.stringify(result);

            expect(readiness).toMatchObject({ ready: true, terminal: true, reason: 'terminal' });
            expect(exported).toContain('Your Antigravity conclusion can be stronger');
            expect(exported).toContain('You are taking over this chat from a previous');
            expect(exported).toContain('Ushman is a software recovery factory');
            expect(exported).toContain('Evaluating how to explain Ushman to a non-technical');
            expect(exported).toContain('Analyzing file output and citations');
            expect(exported).toContain('citations but try to keep them minimal');
        });
    });

    // current_node and model slug derivation

    describe('current_node and model slug derivation', () => {
        it('should derive current_node from latest message timestamp when current_node is missing/invalid', () => {
            const payload = {
                title: 'Derived Node',
                conversation_id: VALID_ID,
                current_node: 'missing-node',
                default_model_slug: 'auto',
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['a1'] },
                    a1: {
                        id: 'a1',
                        parent: 'root',
                        children: ['a2'],
                        message: {
                            id: 'a1',
                            author: { role: 'assistant', name: null, metadata: { model: 'gpt-5' } },
                            create_time: 10,
                            update_time: 10,
                            content: { content_type: 'text', parts: ['old'] },
                            status: 'finished_successfully',
                            end_turn: true,
                            weight: 1,
                            metadata: { model: 'gpt-5' },
                            recipient: 'all',
                            channel: null,
                        },
                    },
                    a2: {
                        id: 'a2',
                        parent: 'a1',
                        children: [],
                        message: {
                            id: 'a2',
                            author: { role: 'assistant', name: null, metadata: {} },
                            create_time: 11,
                            update_time: 22,
                            content: { content_type: 'text', parts: ['new'] },
                            status: 'finished_successfully',
                            end_turn: true,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                    },
                },
            };

            const result = adapter.parseInterceptedData(JSON.stringify(payload), 'url');
            expect(result?.current_node).toBe('a2');
            expect(result?.default_model_slug).toBe('gpt-5');
        });
    });

    // Title normalization

    describe('title normalization', () => {
        it('should derive title from first user message when payload title is a placeholder', () => {
            const payload = {
                title: 'New chat',
                conversation_id: VALID_ID,
                current_node: 'assistant-1',
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['user-1'] },
                    'user-1': {
                        id: 'user-1',
                        parent: 'root',
                        children: ['assistant-1'],
                        message: {
                            id: 'user-1',
                            author: { role: 'user', name: null, metadata: {} },
                            create_time: 1735689600,
                            update_time: 1735689600,
                            content: { content_type: 'text', parts: ['Digital Eye Strain Relief'] },
                            status: 'finished_successfully',
                            end_turn: true,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                    },
                    'assistant-1': {
                        id: 'assistant-1',
                        parent: 'user-1',
                        children: [],
                        message: {
                            id: 'assistant-1',
                            author: { role: 'assistant', name: null, metadata: {} },
                            create_time: 1735689601,
                            update_time: 1735689601,
                            content: {
                                content_type: 'thoughts',
                                thoughts: [{ summary: 'Drafting', content: '', chunks: [] }],
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
            };

            const result = adapter.parseInterceptedData(JSON.stringify(payload), 'url');
            expect(result?.title).toBe('Digital Eye Strain Relief');
        });

        it('should keep placeholder title when first user message is whitespace-only', () => {
            const payload = {
                title: 'New chat',
                conversation_id: VALID_ID,
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
                            content: { content_type: 'text', parts: ['   '] },
                            status: 'finished_successfully',
                            end_turn: true,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                    },
                },
            };
            expect(adapter.parseInterceptedData(JSON.stringify(payload), 'url')?.title).toBe('New chat');
        });
    });

    // SSE stream parsing

    describe('SSE stream payloads', () => {
        it('should build synthetic conversation from f/conversation SSE stream', () => {
            const sseText = [
                'event: message',
                `data: {"conversation_id":"${VALID_ID}","message":{"id":"msg-user","author":{"role":"user","name":null,"metadata":{}},"create_time":1735689600,"update_time":1735689600,"content":{"content_type":"text","parts":["What is calibration?"]},"status":"finished_successfully","end_turn":true,"weight":1,"metadata":{},"recipient":"all","channel":null}}`,
                '',
                'event: message',
                `data: {"conversation_id":"${VALID_ID}","message":{"id":"msg-assistant","author":{"role":"assistant","name":null,"metadata":{}},"create_time":1735689602,"update_time":1735689602,"content":{"content_type":"thoughts","thoughts":[{"summary":"Thinking","content":"Detail","chunks":[],"finished":true}]},"status":"finished_successfully","end_turn":true,"weight":1,"metadata":{"resolved_model_slug":"gpt-5-t-mini"},"recipient":"all","channel":null}}`,
                '',
                'data: [DONE]',
            ].join('\n');

            const result = adapter.parseInterceptedData(sseText, BACKEND_API_URL);
            expect(result).not.toBeNull();
            expect(result.conversation_id).toBe(VALID_ID);
            expect(result.title).toBe('What is calibration?');
            expect(Object.keys(result.mapping).length).toBeGreaterThan(2);
            expect(result.default_model_slug).toBe('gpt-5-t-mini');
            const userMessage = Object.values(result.mapping)
                .map((node: any) => node.message)
                .find((message: any) => message?.author?.role === 'user');
            expect(userMessage?.content?.parts?.[0]).toBe('What is calibration?');
        });

        it('should use embedded direct conversation object found in SSE payload', () => {
            const sseText = [
                'event: message',
                `data: {"conversation":{"title":"From SSE","conversation_id":"${VALID_ID}","mapping":${JSON.stringify(minimalMapping())}}}`,
                '',
                'data: [DONE]',
            ].join('\n');

            const result = adapter.parseInterceptedData(sseText, BACKEND_API_URL);
            expect(result?.title).toBe('From SSE');
        });

        it('should return null for SSE without conversation ID or valid message IDs', () => {
            const sseText = [
                'event: message',
                'data: {"title":"No IDs","message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["hello"]}}}',
                '',
                'data: [DONE]',
            ].join('\n');
            expect(adapter.parseInterceptedData(sseText, BACKEND_API_URL)).toBeNull();
        });

        it('should ignore SSE events where message payload is not an object', () => {
            const sseText = [
                'event: message',
                `data: {"conversation_id":"${VALID_ID}","message":12345}`,
                '',
                'data: [DONE]',
            ].join('\n');
            expect(adapter.parseInterceptedData(sseText, BACKEND_API_URL)).toBeNull();
        });

        it('should normalize unknown author roles to assistant and non-object content to empty text', () => {
            const sseText = [
                'event: message',
                `data: {"conversation_id":"${VALID_ID}","message":{"id":"a1","author":{"role":"critic"},"content":"bad-shape","status":"finished_successfully","end_turn":true}}`,
                '',
                'data: [DONE]',
            ].join('\n');
            const result = adapter.parseInterceptedData(sseText, BACKEND_API_URL);
            expect(result).not.toBeNull();
            const message = result.mapping.a1?.message;
            expect(message?.author.role).toBe('assistant');
            expect(message?.content.parts).toEqual([]);
        });
    });
});
