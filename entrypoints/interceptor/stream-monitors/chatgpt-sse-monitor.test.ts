import { describe, expect, it } from 'bun:test';
import { monitorChatgptSseChunk } from '@/entrypoints/interceptor/stream-monitors/chatgpt-sse-monitor';

describe('chatgpt-sse-monitor', () => {
    it('forwards non-empty chunks to callback', () => {
        const chunks: string[] = [];
        monitorChatgptSseChunk('delta', (chunk) => {
            chunks.push(chunk);
        });
        monitorChatgptSseChunk('', (chunk) => {
            chunks.push(chunk);
        });
        expect(chunks).toEqual(['delta']);
    });

    it('suppresses whitespace-only keep-alive chunks', () => {
        const chunks: string[] = [];
        monitorChatgptSseChunk('\n', (chunk) => {
            chunks.push(chunk);
        });
        monitorChatgptSseChunk('   ', (chunk) => {
            chunks.push(chunk);
        });
        monitorChatgptSseChunk('\t', (chunk) => {
            chunks.push(chunk);
        });
        expect(chunks).toEqual([]);
    });
});
