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
const META_URL = `https://grok.com/rest/app-chat/conversations_v2/${CONV_ID}?includeWorkspaces=true`;
const LOAD_RESPONSES_URL = `https://grok.com/rest/app-chat/conversations/${CONV_ID}/load-responses`;

const seedConversation = (title = 'State Test Conversation') => {
    grokAdapter.parseInterceptedData(
        JSON.stringify({
            conversation: {
                conversationId: CONV_ID,
                title,
                createTime: '2026-02-18T00:00:00Z',
                modifyTime: '2026-02-18T00:00:00Z',
            },
        }),
        META_URL,
    );
    grokAdapter.parseInterceptedData(
        JSON.stringify({
            responseId: 'resp-1',
            message: 'Hello',
            sender: 'human',
            createTime: '2026-02-18T00:00:00Z',
            partial: false,
            model: 'grok-4',
        }),
        LOAD_RESPONSES_URL,
    );
};

describe('Grok Adapter — state isolation', () => {
    it('should reset all state: fresh parse after reset returns default title', () => {
        seedConversation();
        resetGrokAdapterState?.();

        const freshResult = grokAdapter.parseInterceptedData(
            JSON.stringify({
                responseId: 'resp-2',
                message: 'After reset',
                sender: 'assistant',
                createTime: '2026-02-18T00:00:01Z',
                partial: false,
                model: 'grok-4',
            }),
            LOAD_RESPONSES_URL,
        );
        expect(freshResult).not.toBeNull();
        expect((freshResult as { title: string }).title).toBe('Grok Conversation');
    });

    it('should not leak titles across resets', () => {
        const conversationId = '7c5e5d2b-8a9c-4d6f-9e1b-3f2a7c8d9e10';
        const historyData = {
            data: {
                grok_history: {
                    conversations: [
                        {
                            rest_id: conversationId,
                            default_response: { message: '' },
                            created_at: '2026-02-18T00:00:00Z',
                            core: { name: 'Leaked Title' },
                        },
                    ],
                },
            },
        };
        grokAdapter.parseInterceptedData(JSON.stringify(historyData), 'https://x.com/i/api/graphql/test/GrokHistory');
        resetGrokAdapterState?.();

        // Re-parse with same ID after reset — title must not carry over
        const metaUrl = `https://grok.com/rest/app-chat/conversations_v2/${conversationId}?includeWorkspaces=true`;
        grokAdapter.parseInterceptedData(
            JSON.stringify({
                conversation: {
                    conversationId,
                    createTime: '2026-02-18T00:00:00Z',
                    modifyTime: '2026-02-18T00:00:00Z',
                },
            }),
            metaUrl,
        );

        const loadResponsesUrl = `https://grok.com/rest/app-chat/conversations/${conversationId}/load-responses`;
        const conversation = grokAdapter.parseInterceptedData(
            JSON.stringify({
                responseId: 'resp-after-reset',
                message: 'Assistant response',
                sender: 'assistant',
                createTime: '2026-02-18T00:00:01Z',
                partial: false,
                model: 'grok-4',
            }),
            loadResponsesUrl,
        );
        expect(conversation).not.toBeNull();
        expect((conversation as { title: string }).title).not.toBe('Leaked Title');
    });
});
