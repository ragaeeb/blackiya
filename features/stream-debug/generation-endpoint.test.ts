import { describe, expect, it } from 'bun:test';
import { classifyGenerationEndpoint } from '@/features/stream-debug/generation-endpoint';

describe('stream-debug generation endpoint classification', () => {
    it('should classify the supported generation endpoints without retaining query strings', () => {
        expect(
            classifyGenerationEndpoint('https://chatgpt.com/backend-api/f/conversation?authorization=secret', 'POST'),
        ).toEqual({ platform: 'ChatGPT', endpoint: 'chatgpt-generation', path: '/backend-api/f/conversation' });
        expect(
            classifyGenerationEndpoint(
                'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?at=secret',
                'POST',
            ),
        ).toEqual({
            platform: 'Gemini',
            endpoint: 'gemini-generation',
            path: '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
        });
        expect(classifyGenerationEndpoint('https://grok.x.com/2/grok/add_response.json?token=secret', 'POST')).toEqual({
            platform: 'Grok',
            endpoint: 'grok-generation',
            path: '/2/grok/add_response.json',
        });
        expect(classifyGenerationEndpoint('https://x.com/2/grok/add_response.json', 'POST')).toEqual({
            platform: 'Grok',
            endpoint: 'grok-generation',
            path: '/2/grok/add_response.json',
        });
        expect(classifyGenerationEndpoint('https://grok.com/rest/app-chat/conversations/new', 'POST')).toEqual({
            platform: 'Grok',
            endpoint: 'grok-generation',
            path: '/rest/app-chat/conversations/new',
        });
        expect(
            classifyGenerationEndpoint('https://chat.qwen.ai/api/v2/chat/completions?chat_id=secret', 'POST'),
        ).toEqual({
            platform: 'Qwen',
            endpoint: 'qwen-generation',
            path: '/api/v2/chat/completions',
        });
    });

    it('should ignore non-generation methods and auxiliary endpoints', () => {
        expect(classifyGenerationEndpoint('/backend-api/f/conversation', 'GET')).toBeNull();
        expect(classifyGenerationEndpoint('/backend-api/conversation/abc/stream_status', 'POST')).toBeNull();
        expect(classifyGenerationEndpoint('/_/BardChatUi/data/batchexecute?rpcids=MaZiqc', 'POST')).toBeNull();
        expect(classifyGenerationEndpoint('/rest/app-chat/conversations/reconnect-response-v2/abc', 'GET')).toBeNull();
        expect(classifyGenerationEndpoint('/api/v2/chat/completions', 'GET')).toBeNull();
        expect(classifyGenerationEndpoint('/api/v2/chats/abc', 'POST')).toBeNull();
    });

    it('should require the exact HTTPS provider origin for every generation path', () => {
        expect(classifyGenerationEndpoint('https://example.test/backend-api/f/conversation', 'POST')).toBeNull();
        expect(
            classifyGenerationEndpoint(
                'https://chatgpt.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
                'POST',
            ),
        ).toBeNull();
        expect(classifyGenerationEndpoint('https://x.com/api/v2/chat/completions', 'POST')).toBeNull();
        expect(classifyGenerationEndpoint('https://claude.ai/2/grok/add_response.json', 'POST')).toBeNull();
        expect(classifyGenerationEndpoint('http://chat.qwen.ai/api/v2/chat/completions', 'POST')).toBeNull();
        expect(classifyGenerationEndpoint('/backend-api/f/conversation', 'POST')).toBeNull();
    });

    it('should resolve relative generation paths only against an exact HTTPS provider page', () => {
        expect(
            classifyGenerationEndpoint('/backend-api/f/conversation', 'POST', 'https://chatgpt.com/c/synthetic'),
        ).toEqual({
            platform: 'ChatGPT',
            endpoint: 'chatgpt-generation',
            path: '/backend-api/f/conversation',
        });
        expect(
            classifyGenerationEndpoint('/backend-api/f/conversation', 'POST', 'https://example.test/c/synthetic'),
        ).toBeNull();
    });
});
