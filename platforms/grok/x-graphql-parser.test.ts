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

import sampleConversation from '@/data/grok/sample_grok_conversation.json';
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

const X_GRAPHQL_URL = 'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId';

describe('Grok Adapter — x.com GraphQL parsing', () => {
    it('should parse a valid conversation from object', () => {
        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), X_GRAPHQL_URL);
        expect(result).not.toBeNull();
        expect(result?.conversation_id).toBeDefined();
        expect(result?.mapping).toBeDefined();
    });

    it('should parse a valid conversation from string', () => {
        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), X_GRAPHQL_URL);
        expect(result).not.toBeNull();
    });

    it('should return null for invalid data shape', () => {
        const result = grokAdapter.parseInterceptedData(JSON.stringify({ invalid: 'data' }), X_GRAPHQL_URL);
        expect(result).toBeNull();
    });

    it('should return null for empty conversation items array', () => {
        const emptyData = { data: { grok_conversation_items_by_rest_id: { items: [] } } };
        expect(grokAdapter.parseInterceptedData(JSON.stringify(emptyData), X_GRAPHQL_URL)).toBeNull();
    });

    it('should extract conversation title from the first user message', () => {
        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), X_GRAPHQL_URL);
        expect(typeof result?.title).toBe('string');
    });

    it('should create a proper message tree with a grok-root node', () => {
        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), X_GRAPHQL_URL);
        expect(result).not.toBeNull();
        const rootNode = result!.mapping['grok-root'];
        expect(rootNode).toBeDefined();
        expect(rootNode.parent).toBeNull();
        expect(rootNode.message).toBeNull();
    });

    it('should preserve message metadata (grok_mode, sender_type)', () => {
        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), X_GRAPHQL_URL);
        const nodes = (Object.values(result!.mapping) as MessageNode[]).filter((n) => n.message !== null);
        for (const node of nodes) {
            expect(node.message?.metadata.grok_mode).toBeDefined();
            expect(node.message?.metadata.sender_type).toBeDefined();
        }
    });

    it('should handle messages with thinking content', () => {
        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), X_GRAPHQL_URL);
        const thoughtNodes = (Object.values(result!.mapping) as MessageNode[]).filter(
            (n) => n.message?.content.content_type === 'thoughts',
        );
        expect(thoughtNodes.length).toBeGreaterThan(0);
        for (const node of thoughtNodes) {
            expect(Array.isArray(node.message?.content.thoughts)).toBeTrue();
        }
    });
});

describe('Grok Adapter — conversation data structure', () => {
    it('should have all required top-level fields', () => {
        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), X_GRAPHQL_URL);
        expect(result).not.toBeNull();
        expect(typeof result?.title).toBe('string');
        expect(typeof result?.create_time).toBe('number');
        expect(typeof result?.update_time).toBe('number');
        expect(typeof result?.conversation_id).toBe('string');
        expect(typeof result?.mapping).toBe('object');
        expect(typeof result?.current_node).toBe('string');
    });

    it('should have valid message node shapes', () => {
        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), X_GRAPHQL_URL);
        const nodes = Object.values(result!.mapping) as MessageNode[];
        expect(nodes.length).toBeGreaterThan(0);
        for (const node of nodes) {
            expect(node.id).toBeDefined();
            expect(Array.isArray(node.children)).toBeTrue();
        }
    });

    it('should assign correct author roles (user or assistant only)', () => {
        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), X_GRAPHQL_URL);
        const messagesWithContent = (Object.values(result!.mapping) as MessageNode[]).filter(hasMessageNode);
        expect(messagesWithContent.length).toBeGreaterThan(0);
        for (const node of messagesWithContent) {
            expect(['user', 'assistant']).toContain(node.message.author.role);
        }
    });

    it('should have exactly one root node with valid child references', () => {
        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), X_GRAPHQL_URL);
        const rootNodes = (Object.values(result!.mapping) as MessageNode[]).filter((n) => n.parent === null);
        expect(rootNodes.length).toBe(1);

        for (const node of Object.values(result!.mapping) as MessageNode[]) {
            for (const childId of node.children) {
                const childNode = result!.mapping[childId];
                expect(childNode).toBeDefined();
                expect(childNode.parent).toBe(node.id);
            }
        }
    });

    it('should have current_node pointing to a valid mapping entry', () => {
        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), X_GRAPHQL_URL);
        expect(result!.mapping[result!.current_node]).toBeDefined();
    });
});

describe('Grok Adapter — ID synchronization', () => {
    it('should override conversation ID from URL params when present', () => {
        const urlId = '9999999999999999999';
        const url = `https://x.com/i/api/graphql/test/GrokConversationItemsByRestId?variables=${encodeURIComponent(JSON.stringify({ restId: urlId }))}`;
        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), url);
        expect(result?.conversation_id).toBe(urlId);
    });

    it('should fall back to regex extraction when URL variables are not valid JSON', () => {
        const urlId = '8888888888888888888';
        const url = `https://x.com/i/api/graphql/test?variables={%22restId%22%3A%22${urlId}%22, BROKEN_JSON`;
        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), url);
        expect(result?.conversation_id).toBe(urlId);
    });

    it('should use internal conversation ID when no URL restId is present', () => {
        const result = grokAdapter.parseInterceptedData(JSON.stringify(sampleConversation), X_GRAPHQL_URL);
        expect(result?.conversation_id).toBeDefined();
        expect((result?.conversation_id ?? '').length).toBeGreaterThan(0);
    });
});
