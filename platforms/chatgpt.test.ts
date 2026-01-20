/**
 * Tests for ChatGPT Platform Adapter
 *
 * TDD tests for conversation ID extraction, API URL building, and filename formatting
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

describe('ChatGPT Platform Adapter', () => {
    let chatGPTAdapter: any;

    beforeAll(async () => {
        // Dynamic import to ensure mocks apply
        const module = await import('@/platforms/chatgpt');
        chatGPTAdapter = module.chatGPTAdapter;
    });

    describe('extractConversationId', () => {
        it('should extract conversation ID from standard chat URL', () => {
            const url = 'https://chatgpt.com/c/696bc3d5-fa84-8328-b209-4d65cb229e59';
            const id = chatGPTAdapter.extractConversationId(url);
            expect(id).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
        });

        it('should extract conversation ID from GPT/gizmo URL format', () => {
            const url = 'https://chatgpt.com/g/g-abc123/c/696bc3d5-fa84-8328-b209-4d65cb229e59';
            const id = chatGPTAdapter.extractConversationId(url);
            expect(id).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
        });

        it('should extract conversation ID from URL with query parameters', () => {
            const url = 'https://chatgpt.com/c/696bc3d5-fa84-8328-b209-4d65cb229e59?model=gpt-4';
            const id = chatGPTAdapter.extractConversationId(url);
            expect(id).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
        });

        it('should return null for homepage URL', () => {
            const url = 'https://chatgpt.com/';
            const id = chatGPTAdapter.extractConversationId(url);
            expect(id).toBeNull();
        });

        it('should return null for non-ChatGPT URL', () => {
            const url = 'https://google.com/c/123';
            const id = chatGPTAdapter.extractConversationId(url);
            expect(id).toBeNull();
        });

        it('should return null for invalid conversation ID format', () => {
            const url = 'https://chatgpt.com/c/invalid-id';
            const id = chatGPTAdapter.extractConversationId(url);
            expect(id).toBeNull();
        });

        it('should handle chat.openai.com legacy domain', () => {
            const url = 'https://chat.openai.com/c/696bc3d5-fa84-8328-b209-4d65cb229e59';
            const id = chatGPTAdapter.extractConversationId(url);
            expect(id).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
        });
    });

    describe('parseInterceptedData', () => {
        it('should parse valid ChatGPT JSON data', () => {
            const mockData = {
                title: 'Test Conversation',
                conversation_id: 'uuid-123',
                mapping: { 'node-1': {} },
            };
            const result = chatGPTAdapter.parseInterceptedData(JSON.stringify(mockData), 'url');
            expect(result).not.toBeNull();
            expect(result?.title).toBe('Test Conversation');
        });

        it('should return null for invalid data', () => {
            const result = chatGPTAdapter.parseInterceptedData(JSON.stringify({ foo: 'bar' }), 'url');
            expect(result).toBeNull();
        });
    });

    describe('formatFilename', () => {
        it('should format filename with title and timestamp', () => {
            const data = {
                title: 'Test Conversation',
                create_time: 1768670166.492617,
                update_time: 1768671022.523312,
                mapping: {},
                conversation_id: '696bc3d5-fa84-8328-b209-4d65cb229e59',
                current_node: 'node-1',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gpt-4',
                safe_urls: [],
                blocked_urls: [],
            };

            const filename = chatGPTAdapter.formatFilename(data);

            // Should contain sanitized title
            expect(filename).toContain('Test_Conversation');
            // Should contain timestamp
            expect(filename).toMatch(/\d{4}-\d{2}-\d{2}/);
        });

        it('should sanitize special characters in title', () => {
            const data = {
                title: 'Test: Special/Characters\\Here?',
                create_time: 1768670166.492617,
                update_time: 1768671022.523312,
                mapping: {},
                conversation_id: '696bc3d5-fa84-8328-b209-4d65cb229e59',
                current_node: 'node-1',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gpt-4',
                safe_urls: [],
                blocked_urls: [],
            };

            const filename = chatGPTAdapter.formatFilename(data);

            // Should not contain invalid filename characters
            expect(filename).not.toMatch(/[:/\\?<>"|*]/);
        });

        it('should handle empty title', () => {
            const data = {
                title: '',
                create_time: 1768670166.492617,
                update_time: 1768671022.523312,
                mapping: {},
                conversation_id: '696bc3d5-fa84-8328-b209-4d65cb229e59',
                current_node: 'node-1',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gpt-4',
                safe_urls: [],
                blocked_urls: [],
            };

            const filename = chatGPTAdapter.formatFilename(data);

            // Should use conversation ID prefix for untitled conversations
            expect(filename).toContain('conversation');
        });

        it('should truncate very long titles', () => {
            const longTitle = 'A'.repeat(200);
            const data = {
                title: longTitle,
                create_time: 1768670166.492617,
                update_time: 1768671022.523312,
                mapping: {},
                conversation_id: '696bc3d5-fa84-8328-b209-4d65cb229e59',
                current_node: 'node-1',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gpt-4',
                safe_urls: [],
                blocked_urls: [],
            };

            const filename = chatGPTAdapter.formatFilename(data);

            // Filename should be reasonable length (under 100 chars for title part)
            expect(filename.length).toBeLessThan(150);
        });
    });

    describe('apiEndpointPattern', () => {
        it('should match ChatGPT conversation API endpoint', () => {
            const endpoint = 'https://chatgpt.com/backend-api/conversation/696bc3d5-fa84-8328-b209-4d65cb229e59';
            expect(chatGPTAdapter.apiEndpointPattern.test(endpoint)).toBe(true);
        });

        it('should not match other API endpoints', () => {
            const endpoint = 'https://chatgpt.com/backend-api/models';
            expect(chatGPTAdapter.apiEndpointPattern.test(endpoint)).toBe(false);
        });
    });
});
