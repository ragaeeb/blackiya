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
});
