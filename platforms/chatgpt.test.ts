/**
 * Tests for ChatGPT Platform Adapter
 *
 * TDD tests for conversation ID extraction, API URL building, and filename formatting
 */

import { beforeAll, describe, expect, it, mock } from 'bun:test';

// Mock logger to avoid importing wxt/browser in test environment
mock.module('@/utils/logger', () => ({
    logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        setLevel: () => {},
    },
}));

describe('ChatGPT Platform Adapter', () => {
    let adapter: any;

    beforeAll(async () => {
        // Dynamic import to ensure mocks apply
        const module = await import('@/platforms/chatgpt');
        adapter = module.createChatGPTAdapter();
    });

    describe('extractConversationId', () => {
        it('should extract conversation ID from standard chat URL', () => {
            const url = 'https://chatgpt.com/c/696bc3d5-fa84-8328-b209-4d65cb229e59';
            const id = adapter.extractConversationId(url);
            expect(id).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
        });

        it('should extract conversation ID from GPT/gizmo URL format', () => {
            const url = 'https://chatgpt.com/g/g-abc123/c/696bc3d5-fa84-8328-b209-4d65cb229e59';
            const id = adapter.extractConversationId(url);
            expect(id).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
        });

        it('should extract conversation ID from URL with query parameters', () => {
            const url = 'https://chatgpt.com/c/696bc3d5-fa84-8328-b209-4d65cb229e59?model=gpt-4';
            const id = adapter.extractConversationId(url);
            expect(id).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
        });

        it('should return null for homepage URL', () => {
            const url = 'https://chatgpt.com/';
            const id = adapter.extractConversationId(url);
            expect(id).toBeNull();
        });

        it('should return null for non-ChatGPT URL', () => {
            const url = 'https://google.com/c/123';
            const id = adapter.extractConversationId(url);
            expect(id).toBeNull();
        });

        it('should return null for invalid conversation ID format', () => {
            const url = 'https://chatgpt.com/c/invalid-id';
            const id = adapter.extractConversationId(url);
            expect(id).toBeNull();
        });

        it('should handle chat.openai.com legacy domain', () => {
            const url = 'https://chat.openai.com/c/696bc3d5-fa84-8328-b209-4d65cb229e59';
            const id = adapter.extractConversationId(url);
            expect(id).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
        });
    });

    describe('parseInterceptedData', () => {
        it('should parse valid ChatGPT JSON data', () => {
            const mockData = {
                title: 'Test Conversation',
                conversation_id: '696bc3d5-fa84-8328-b209-4d65cb229e59',
                mapping: { 'node-1': {} },
            };
            const result = adapter.parseInterceptedData(JSON.stringify(mockData), 'url');
            expect(result).not.toBeNull();
            expect(result?.title).toBe('Test Conversation');
        });

        it('should normalize id to conversation_id when needed', () => {
            const mockData = {
                title: 'Test Conversation',
                id: '696bc3d5-fa84-8328-b209-4d65cb229e59',
                mapping: { 'node-1': {} },
            };
            const result = adapter.parseInterceptedData(JSON.stringify(mockData), 'url');
            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
        });

        it('should parse wrapped conversation payload', () => {
            const wrapped = {
                conversation: {
                    title: 'Wrapped',
                    conversation_id: '696bc3d5-fa84-8328-b209-4d65cb229e59',
                    mapping: { 'node-1': {} },
                },
            };
            const result = adapter.parseInterceptedData(JSON.stringify(wrapped), 'url');
            expect(result).not.toBeNull();
            expect(result?.title).toBe('Wrapped');
            expect(result?.conversation_id).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
        });

        it('should return null for invalid data', () => {
            const result = adapter.parseInterceptedData(JSON.stringify({ foo: 'bar' }), 'url');
            expect(result).toBeNull();
        });

        it('should parse conversation payloads with missing title by normalizing to empty string', () => {
            const mockData = {
                conversation_id: '696bc3d5-fa84-8328-b209-4d65cb229e59',
                mapping: { root: { id: 'root', message: null, parent: null, children: [] } },
                current_node: 'root',
            };
            const result = adapter.parseInterceptedData(JSON.stringify(mockData), 'url');
            expect(result).not.toBeNull();
            expect(result?.title).toBe('');
        });

        it('should parse ChatGPT f/conversation SSE payload into synthetic conversation data', () => {
            const ssePayload = [
                'event: message',
                'data: {"conversation_id":"696bc3d5-fa84-8328-b209-4d65cb229e59","message":{"id":"msg-user","author":{"role":"user","name":null,"metadata":{}},"create_time":1735689600,"update_time":1735689600,"content":{"content_type":"text","parts":["What is calibration?"]},"status":"finished_successfully","end_turn":true,"weight":1,"metadata":{},"recipient":"all","channel":null}}',
                '',
                'event: message',
                'data: {"conversation_id":"696bc3d5-fa84-8328-b209-4d65cb229e59","message":{"id":"msg-assistant","author":{"role":"assistant","name":null,"metadata":{}},"create_time":1735689602,"update_time":1735689602,"content":{"content_type":"thoughts","thoughts":[{"summary":"Considering the user question","content":"Calibration means adapting capture logic to observed runtime signals.","chunks":[],"finished":true}]},"status":"finished_successfully","end_turn":true,"weight":1,"metadata":{"resolved_model_slug":"gpt-5-t-mini"},"recipient":"all","channel":null}}',
                '',
                'data: [DONE]',
            ].join('\n');

            const result = adapter.parseInterceptedData(ssePayload, 'https://chatgpt.com/backend-api/f/conversation');
            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
            expect(result?.title).toBe('What is calibration?');
            expect(Object.keys(result?.mapping ?? {}).length).toBeGreaterThan(2);
            expect(result?.default_model_slug).toBe('gpt-5-t-mini');
        });

        it('should derive title from first user message when payload title is a placeholder', () => {
            const mockData = {
                title: 'New chat',
                conversation_id: '696bc3d5-fa84-8328-b209-4d65cb229e59',
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

            const result = adapter.parseInterceptedData(JSON.stringify(mockData), 'url');
            expect(result).not.toBeNull();
            expect(result?.title).toBe('Digital Eye Strain Relief');
        });
    });

    describe('evaluateReadiness', () => {
        it('should return not-ready for thoughts-only assistant payloads', () => {
            const data = {
                title: 'New chat',
                create_time: 1735689600,
                update_time: 1735689601,
                conversation_id: '696bc3d5-fa84-8328-b209-4d65cb229e59',
                current_node: 'assistant-1',
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['assistant-1'] },
                    'assistant-1': {
                        id: 'assistant-1',
                        parent: 'root',
                        children: [],
                        message: {
                            id: 'assistant-1',
                            author: { role: 'assistant', name: null, metadata: {} },
                            create_time: 1735689601,
                            update_time: 1735689601,
                            content: {
                                content_type: 'thoughts',
                                thoughts: [{ summary: 'Thinking', content: 'Draft', chunks: [], finished: true }],
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
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gpt-5',
                safe_urls: [],
                blocked_urls: [],
            };

            const readiness = adapter.evaluateReadiness(data);
            expect(readiness.ready).toBe(false);
            expect(readiness.reason).toBe('assistant-text-missing');
        });

        it('should return ready for finished terminal assistant text payloads', () => {
            const data = {
                title: 'Test',
                create_time: 1735689600,
                update_time: 1735689602,
                conversation_id: '696bc3d5-fa84-8328-b209-4d65cb229e59',
                current_node: 'assistant-2',
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['assistant-1'] },
                    'assistant-1': {
                        id: 'assistant-1',
                        parent: 'root',
                        children: ['assistant-2'],
                        message: {
                            id: 'assistant-1',
                            author: { role: 'assistant', name: null, metadata: {} },
                            create_time: 1735689601,
                            update_time: 1735689601,
                            content: {
                                content_type: 'thoughts',
                                thoughts: [{ summary: 'Thinking', content: 'Draft', chunks: [], finished: true }],
                            },
                            status: 'finished_successfully',
                            end_turn: false,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                    },
                    'assistant-2': {
                        id: 'assistant-2',
                        parent: 'assistant-1',
                        children: [],
                        message: {
                            id: 'assistant-2',
                            author: { role: 'assistant', name: null, metadata: {} },
                            create_time: 1735689602,
                            update_time: 1735689602,
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
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gpt-5',
                safe_urls: [],
                blocked_urls: [],
            };

            const readiness = adapter.evaluateReadiness(data);
            expect(readiness.ready).toBe(true);
            expect(readiness.reason).toBe('terminal');
            expect(readiness.contentHash).not.toBeNull();
        });

        it('should require the latest assistant text turn to be terminal', () => {
            const data = {
                title: 'Test',
                create_time: 1735689600,
                update_time: 1735689603,
                conversation_id: '696bc3d5-fa84-8328-b209-4d65cb229e59',
                current_node: 'assistant-2',
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['assistant-1'] },
                    'assistant-1': {
                        id: 'assistant-1',
                        parent: 'root',
                        children: ['assistant-2'],
                        message: {
                            id: 'assistant-1',
                            author: { role: 'assistant', name: null, metadata: {} },
                            create_time: 1735689601,
                            update_time: 1735689601,
                            content: { content_type: 'text', parts: ['Older complete turn'] },
                            status: 'finished_successfully',
                            end_turn: true,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                    },
                    'assistant-2': {
                        id: 'assistant-2',
                        parent: 'assistant-1',
                        children: [],
                        message: {
                            id: 'assistant-2',
                            author: { role: 'assistant', name: null, metadata: {} },
                            create_time: 1735689603,
                            update_time: 1735689603,
                            content: { content_type: 'text', parts: ['Latest still not terminal'] },
                            status: 'finished_successfully',
                            end_turn: false,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                    },
                },
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gpt-5',
                safe_urls: [],
                blocked_urls: [],
            };

            const readiness = adapter.evaluateReadiness(data);
            expect(readiness.ready).toBe(false);
            expect(readiness.reason).toBe('assistant-latest-text-not-terminal-turn');
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

            const filename = adapter.formatFilename(data);

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

            const filename = adapter.formatFilename(data);

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

            const filename = adapter.formatFilename(data);

            // Should use conversation ID prefix for untitled conversations
            expect(filename).toContain('conversation');
        });

        it('should use first user message as filename fallback when title is empty', () => {
            const data = {
                title: '',
                create_time: 1768670166.492617,
                update_time: 1768671022.523312,
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['u1'] },
                    u1: {
                        id: 'u1',
                        parent: 'root',
                        children: [],
                        message: {
                            id: 'u1',
                            author: { role: 'user', name: null, metadata: {} },
                            create_time: 1768670166.492617,
                            update_time: 1768670166.492617,
                            content: { content_type: 'text', parts: ['Total Sahabah Estimates and source ranges'] },
                            status: 'finished_successfully',
                            end_turn: true,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                    },
                },
                conversation_id: '696bc3d5-fa84-8328-b209-4d65cb229e59',
                current_node: 'u1',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gpt-4',
                safe_urls: [],
                blocked_urls: [],
            };

            const filename = adapter.formatFilename(data);
            expect(filename).toContain('Total_Sahabah_Estimates_and_source_ranges');
            expect(filename).not.toContain('conversation_696bc3d5');
        });

        it('should use first user message as fallback when title is placeholder "New chat"', () => {
            const data = {
                title: 'New chat',
                create_time: 1768670166.492617,
                update_time: 1768671022.523312,
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['u1'] },
                    u1: {
                        id: 'u1',
                        parent: 'root',
                        children: [],
                        message: {
                            id: 'u1',
                            author: { role: 'user', name: null, metadata: {} },
                            create_time: 1768670166.492617,
                            update_time: 1768670166.492617,
                            content: {
                                content_type: 'text',
                                parts: ['Digital Eye Strain Relief tips and habits'],
                            },
                            status: 'finished_successfully',
                            end_turn: true,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                    },
                },
                conversation_id: '696bc3d5-fa84-8328-b209-4d65cb229e59',
                current_node: 'u1',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gpt-4',
                safe_urls: [],
                blocked_urls: [],
            };

            const filename = adapter.formatFilename(data);
            expect(filename).toContain('Digital_Eye_Strain_Relief_tips_and_habits');
            expect(filename).not.toContain('New_chat');
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

            const filename = adapter.formatFilename(data);

            // Filename should be reasonable length (under 100 chars for title part)
            expect(filename.length).toBeLessThan(150);
        });
    });

    describe('apiEndpointPattern', () => {
        it('should match ChatGPT conversation API endpoint', () => {
            const endpoint = 'https://chatgpt.com/backend-api/conversation/696bc3d5-fa84-8328-b209-4d65cb229e59';
            expect(adapter.apiEndpointPattern.test(endpoint)).toBe(true);
        });

        it('should match ChatGPT conversation API endpoint with query params', () => {
            const endpoint =
                'https://chatgpt.com/backend-api/conversation/696bc3d5-fa84-8328-b209-4d65cb229e59?foo=bar';
            expect(adapter.apiEndpointPattern.test(endpoint)).toBe(true);
        });

        it('should not match other API endpoints', () => {
            const endpoint = 'https://chatgpt.com/backend-api/models';
            expect(adapter.apiEndpointPattern.test(endpoint)).toBe(false);
        });

        it('should match ChatGPT f/conversation endpoint', () => {
            const endpoint = 'https://chatgpt.com/backend-api/f/conversation';
            expect(adapter.apiEndpointPattern.test(endpoint)).toBe(true);
        });
    });

    describe('evaluateReadiness', () => {
        it('marks terminal-ready conversation snapshots correctly', () => {
            const data = {
                title: 'Ready',
                create_time: 1,
                update_time: 2,
                conversation_id: '696bc3d5-fa84-8328-b209-4d65cb229e59',
                current_node: 'assistant',
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['assistant'] },
                    assistant: {
                        id: 'assistant',
                        parent: 'root',
                        children: [],
                        message: {
                            id: 'assistant',
                            author: { role: 'assistant', name: null, metadata: {} },
                            create_time: 1,
                            update_time: 2,
                            content: { content_type: 'text', parts: ['hello world'] },
                            status: 'finished_successfully',
                            end_turn: true,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                    },
                },
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gpt-5',
                safe_urls: [],
                blocked_urls: [],
            };

            const readiness = adapter.evaluateReadiness?.(data as any);
            expect(readiness?.ready).toBe(true);
            expect(readiness?.terminal).toBe(true);
            expect(typeof readiness?.contentHash).toBe('string');
            expect(readiness?.latestAssistantTextLength).toBeGreaterThan(0);
        });
    });

    describe('completion trigger flow', () => {
        it('should match stream_status completion endpoint', () => {
            const url =
                'https://chatgpt.com/backend-api/conversation/696bc3d5-fa84-8328-b209-4d65cb229e59/stream_status';
            expect(adapter.completionTriggerPattern.test(url)).toBe(true);
        });

        it('should not match textdocs endpoint as completion signal', () => {
            const url = 'https://chatgpt.com/backend-api/conversation/696bc3d5-fa84-8328-b209-4d65cb229e59/textdocs';
            expect(adapter.completionTriggerPattern.test(url)).toBe(false);
        });

        it('should extract conversation ID from completion endpoint URL', () => {
            const url =
                'https://chatgpt.com/backend-api/conversation/696bc3d5-fa84-8328-b209-4d65cb229e59/stream_status';
            expect(adapter.extractConversationIdFromUrl(url)).toBe('696bc3d5-fa84-8328-b209-4d65cb229e59');
        });

        it('should not extract conversation ID from textdocs endpoint URL', () => {
            const url = 'https://chatgpt.com/backend-api/conversation/696bc3d5-fa84-8328-b209-4d65cb229e59/textdocs';
            expect(adapter.extractConversationIdFromUrl(url)).toBeNull();
        });

        it('should build full conversation API URL from conversation ID', () => {
            const url = adapter.buildApiUrl('696bc3d5-fa84-8328-b209-4d65cb229e59');
            expect(url).toBe('https://chatgpt.com/backend-api/conversation/696bc3d5-fa84-8328-b209-4d65cb229e59');
        });

        it('should provide multiple fetch URL candidates for calibration retries', () => {
            const urls = adapter.buildApiUrls('696bc3d5-fa84-8328-b209-4d65cb229e59');
            expect(urls).toContain('https://chatgpt.com/backend-api/conversation/696bc3d5-fa84-8328-b209-4d65cb229e59');
            expect(urls).toContain(
                'https://chat.openai.com/backend-api/conversation/696bc3d5-fa84-8328-b209-4d65cb229e59',
            );
            expect(urls).not.toContain(
                'https://chatgpt.com/backend-api/f/conversation/696bc3d5-fa84-8328-b209-4d65cb229e59',
            );
        });
    });
});
