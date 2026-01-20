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

import sampleConversation from '@/data/grok/sample_grok_conversation.json';
import sampleHistory from '@/data/grok/sample_grok_history.json';

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

        it('should not match other GraphQL endpoints', () => {
            const endpoint = 'https://x.com/i/api/graphql/abc123/UserByScreenName';
            expect(grokAdapter.apiEndpointPattern.test(endpoint)).toBe(false);
        });

        it('should not match non-API URLs', () => {
            const endpoint = 'https://x.com/i/grok?conversation=123';
            expect(grokAdapter.apiEndpointPattern.test(endpoint)).toBe(false);
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
            const nodes = Object.values(result!.mapping).filter((n) => n.message !== null);

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
            const nodes = Object.values(result!.mapping).filter((n) => n.message?.content.content_type === 'thoughts');

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
            const nodes = Object.values(result!.mapping);
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
            const messagesWithContent = Object.values(result!.mapping).filter((n): n is any => n.message !== null);

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
            const rootNodes = Object.values(result!.mapping).filter((n) => n.parent === null);
            expect(rootNodes.length).toBe(1);

            // Verify children point to valid nodes
            for (const node of Object.values(result!.mapping)) {
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
