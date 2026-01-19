/**
 * Tests for Gemini Platform Adapter
 *
 * Tests for conversation ID extraction, batchexecute parsing, and filename formatting
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { geminiAdapter } from './gemini';

describe('Gemini Platform Adapter', () => {
    describe('isPlatformUrl', () => {
        it('should identify Gemini URLs', () => {
            expect(geminiAdapter.isPlatformUrl('https://gemini.google.com/app')).toBe(true);
            expect(geminiAdapter.isPlatformUrl('https://gemini.google.com/app/123abc456')).toBe(true);
            expect(geminiAdapter.isPlatformUrl('https://gemini.google.com/share/abc123')).toBe(true);
        });

        it('should reject non-Gemini URLs', () => {
            expect(geminiAdapter.isPlatformUrl('https://chatgpt.com')).toBe(false);
            expect(geminiAdapter.isPlatformUrl('https://google.com')).toBe(false);
            expect(geminiAdapter.isPlatformUrl('https://example.com')).toBe(false);
        });
    });

    describe('extractConversationId', () => {
        it('should extract conversation ID from /app/ URLs', () => {
            const url = 'https://gemini.google.com/app/e0b55b3f4f1f7083';
            const id = geminiAdapter.extractConversationId(url);
            expect(id).toBe('e0b55b3f4f1f7083');
        });

        it('should extract conversation ID from user reported URL', () => {
            const url = 'https://gemini.google.com/app/9cf87bbddf79d497';
            const id = geminiAdapter.extractConversationId(url);
            expect(id).toBe('9cf87bbddf79d497');
        });

        it('should extract conversation ID from /app/ URL with query params', () => {
            const url = 'https://gemini.google.com/app/123abc456?hl=en';
            const id = geminiAdapter.extractConversationId(url);
            expect(id).toBe('123abc456');
        });

        it('should extract conversation ID from /share/ URLs', () => {
            const url = 'https://gemini.google.com/share/shared-id-123';
            const id = geminiAdapter.extractConversationId(url);
            expect(id).toBe('shared-id-123');
        });

        it('should return null for homepage URL', () => {
            const url = 'https://gemini.google.com/';
            const id = geminiAdapter.extractConversationId(url);
            expect(id).toBeNull();
        });

        it('should return null for non-Gemini URL', () => {
            const url = 'https://google.com/app/123';
            const id = geminiAdapter.extractConversationId(url);
            expect(id).toBeNull();
        });

        it('should handle hex IDs with mixed case', () => {
            const url = 'https://gemini.google.com/app/ABC123def456';
            const id = geminiAdapter.extractConversationId(url);
            expect(id).toBe('ABC123def456');
        });
    });

    describe('apiEndpointPattern', () => {
        it('should match batchexecute endpoint with hNvQHb RPC ID', () => {
            const endpoint =
                'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&source-path=%2Fapp%2Fe0b55b3f4f1f7083';
            expect(geminiAdapter.apiEndpointPattern.test(endpoint)).toBe(true);
        });

        it('should match batchexecute with hNvQHb in middle of rpcids param', () => {
            const endpoint =
                'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=someOther,hNvQHb,another&source-path=%2Fapp';
            expect(geminiAdapter.apiEndpointPattern.test(endpoint)).toBe(true);
        });

        it('should not match batchexecute without hNvQHb RPC ID', () => {
            const endpoint =
                'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=L5adhe&source-path=%2Fapp';
            expect(geminiAdapter.apiEndpointPattern.test(endpoint)).toBe(false);
        });

        it('should not match other Gemini API endpoints', () => {
            const endpoint = 'https://gemini.google.com/api/v1/conversations';
            expect(geminiAdapter.apiEndpointPattern.test(endpoint)).toBe(false);
        });

        it('should not match endpoints with partial RPC ID match', () => {
            const endpoint = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQH';
            expect(geminiAdapter.apiEndpointPattern.test(endpoint)).toBe(false);
        });
    });

    describe('parseInterceptedData', () => {
        it('should parse valid batchexecute response with magic header', () => {
            // Simulate the actual structure from the network capture
            // Root node: [ ["id", "rid"], null, [messages] ]
            const innerPayload = JSON.stringify([
                [
                    [
                        ['c_e0b55b3f4f1f7083', 'r_7718ac9ba6c20bde'],
                        null,
                        [['User message content here'], ['Assistant response content here']],
                    ],
                ],
            ]);

            const mockResponse = `)]}'\n\n100977\n[["wrb.fr","hNvQHb","${innerPayload.replace(/"/g, '\\"')}",null,null,null,"generic"]]`;

            const result = geminiAdapter.parseInterceptedData(mockResponse, 'test-url');

            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe('e0b55b3f4f1f7083'); // Normalized (c_ prefix removed)
            expect(Object.keys(result?.mapping || {}).length).toBe(2);
        });

        it('should parse batchexecute response with split magic header', () => {
            // Simulate the split header variation
            const innerPayload = JSON.stringify([[[['c_split123', 'r_split456'], null, [['Split message content']]]]]);

            const mockResponse = `)
]
}'

100977
[["wrb.fr","hNvQHb","${innerPayload.replace(/"/g, '\\"')}",null,null,null,"generic"]]`;

            const result = geminiAdapter.parseInterceptedData(mockResponse, 'test-url');

            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe('split123');
        });

        it('should parse real data fixture correctly', () => {
            const fixturePath = join(import.meta.dir, '../data/sample_gemini_response.txt');
            const fixtureContent = readFileSync(fixturePath, 'utf-8');

            const result = geminiAdapter.parseInterceptedData(fixtureContent, 'test-url');

            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe('e0b55b3f4f1f7083');
        });

        it('should return null for response with wrong RPC ID', () => {
            const mockResponse = `)]}'\n\n123\n[["wrb.fr","wrongId","[[[\\"rc_id\\",[\\"Message\\"]]]]",null,null,null,"generic"]]`;

            const result = geminiAdapter.parseInterceptedData(mockResponse, 'test-url');
            expect(result).toBeNull();
        });

        it('should return null for malformed JSON', () => {
            const mockResponse = `)]}'\n\n123\nthis is not valid JSON`;

            const result = geminiAdapter.parseInterceptedData(mockResponse, 'test-url');
            expect(result).toBeNull();
        });

        it('should return null for empty response', () => {
            const result = geminiAdapter.parseInterceptedData('', 'test-url');
            expect(result).toBeNull();
        });

        it('should handle deeply nested message content', () => {
            const innerPayload = JSON.stringify([
                [
                    [
                        ['c_deep123', 'r_response'],
                        null,
                        [[['Complex', 'nested', 'array', 'structure']], [{ type: 'object', data: 'value' }]],
                    ],
                ],
            ]);

            const mockResponse = `)]}'\n\n200\n[["wrb.fr","hNvQHb","${innerPayload.replace(/"/g, '\\"')}",null,null,null,"generic"]]`;

            const result = geminiAdapter.parseInterceptedData(mockResponse, 'test-url');

            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe('deep123');
            expect(Object.keys(result?.mapping || {}).length).toBe(2);
        });

        it('should create proper parent-child relationships in mapping', () => {
            const innerPayload = JSON.stringify([
                [[['c_parent123', 'r_response'], null, [['First message'], ['Second message'], ['Third message']]]],
            ]);

            const mockResponse = `)]}'\n\n150\n[["wrb.fr","hNvQHb","${innerPayload.replace(/"/g, '\\"')}",null,null,null,"generic"]]`;

            const result = geminiAdapter.parseInterceptedData(mockResponse, 'test-url');

            expect(result).not.toBeNull();

            const mapping = result?.mapping || {};

            // Check first segment
            expect(mapping['segment-0']?.parent).toBeNull();
            expect(mapping['segment-0']?.children).toEqual(['segment-1']);

            // Check middle segment
            expect(mapping['segment-1']?.parent).toBe('segment-0');
            expect(mapping['segment-1']?.children).toEqual(['segment-2']);

            // Check last segment
            expect(mapping['segment-2']?.parent).toBe('segment-1');
            expect(mapping['segment-2']?.children).toEqual([]);
        });

        it('should handle empty message array', () => {
            const innerPayload = JSON.stringify([[[['c_empty123', 'r_response'], null, []]]]);

            const mockResponse = `)]}'\n\n100\n[["wrb.fr","hNvQHb","${innerPayload.replace(/"/g, '\\"')}",null,null,null,"generic"]]`;

            const result = geminiAdapter.parseInterceptedData(mockResponse, 'test-url');

            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe('empty123');
            expect(Object.keys(result?.mapping || {}).length).toBe(0);
        });

        it('should normalize conversation ID by removing c_ prefix', () => {
            const innerPayload = JSON.stringify([[[['c_normalize123', 'r_response'], null, [['Test message']]]]]);

            const mockResponse = `)]}'\n\n100\n[["wrb.fr","hNvQHb","${innerPayload.replace(/"/g, '\\"')}",null,null,null,"generic"]]`;

            const result = geminiAdapter.parseInterceptedData(mockResponse, 'test-url');

            // Should strip c_ prefix
            expect(result?.conversation_id).toBe('normalize123');
        });

        it('should handle conversation ID without c_ prefix', () => {
            const innerPayload = JSON.stringify([[[['already_normalized', 'r_response'], null, [['Test message']]]]]);

            const mockResponse = `)]}'\n\n100\n[["wrb.fr","hNvQHb","${innerPayload.replace(/"/g, '\\"')}",null,null,null,"generic"]]`;

            const result = geminiAdapter.parseInterceptedData(mockResponse, 'test-url');

            // Should keep as-is
            expect(result?.conversation_id).toBe('already_normalized');
        });
    });

    describe('formatFilename', () => {
        it('should format filename with title and timestamp', () => {
            const data = {
                title: 'Arabic Translation Task',
                create_time: 1768920494.173,
                update_time: 1768933170.377,
                conversation_id: 'e0b55b3f4f1f7083',
                mapping: {},
                current_node: 'segment-0',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gemini-2.0',
                safe_urls: [],
                blocked_urls: [],
            };

            const filename = geminiAdapter.formatFilename(data);

            expect(filename).toContain('Arabic_Translation_Task');
            expect(filename).toMatch(/\d{4}-\d{2}-\d{2}/);
        });

        it('should sanitize special characters in title', () => {
            const data = {
                title: 'Test: Special/Characters\\Here?',
                create_time: 1768920494.173,
                update_time: 1768933170.377,
                conversation_id: 'test123',
                mapping: {},
                current_node: 'segment-0',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gemini-2.0',
                safe_urls: [],
                blocked_urls: [],
            };

            const filename = geminiAdapter.formatFilename(data);

            // Should not contain invalid filename characters
            expect(filename).not.toMatch(/[:/\\?<>"|*]/);
        });

        it('should handle empty title gracefully', () => {
            const data = {
                title: '',
                create_time: 1768920494.173,
                update_time: 1768933170.377,
                conversation_id: 'empty123',
                mapping: {},
                current_node: 'segment-0',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gemini-2.0',
                safe_urls: [],
                blocked_urls: [],
            };

            const filename = geminiAdapter.formatFilename(data);

            // Should use default title
            expect(filename).toContain('Gemini_Conversation');
        });

        it('should truncate very long titles', () => {
            const longTitle = 'A'.repeat(200);
            const data = {
                title: longTitle,
                create_time: 1768920494.173,
                update_time: 1768933170.377,
                conversation_id: 'long123',
                mapping: {},
                current_node: 'segment-0',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gemini-2.0',
                safe_urls: [],
                blocked_urls: [],
            };

            const filename = geminiAdapter.formatFilename(data);

            // Should be reasonable length (title max 80 + timestamp ~20)
            expect(filename.length).toBeLessThan(150);
        });

        it('should use update_time for timestamp if available', () => {
            const data = {
                title: 'Test Conversation',
                create_time: 1768920494.173,
                update_time: 1768933170.377,
                conversation_id: 'test123',
                mapping: {},
                current_node: 'segment-0',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gemini-2.0',
                safe_urls: [],
                blocked_urls: [],
            };

            const filename = geminiAdapter.formatFilename(data);

            // Should use update_time (timestamp value)
            expect(filename).toMatch(/Test_Conversation_\d{4}-\d{2}-\d{2}/);
        });
    });

    describe('getButtonInjectionTarget', () => {
        let originalDocument: any;

        beforeEach(() => {
            originalDocument = global.document;
        });

        afterEach(() => {
            global.document = originalDocument;
        });

        it('should return null when no valid target exists', () => {
            // Mock empty DOM
            global.document = {
                querySelector: () => null,
            } as any;

            const target = geminiAdapter.getButtonInjectionTarget();
            expect(target).toBeNull();
        });
    });
});
