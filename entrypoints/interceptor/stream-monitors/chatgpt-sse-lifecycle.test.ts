import { beforeEach, describe, expect, it, mock } from 'bun:test';

let streamedChunk = '';
const capturedSseBuffers: string[] = [];

mock.module('@/entrypoints/interceptor/text-extraction', () => ({
    extractAssistantTextSnapshotFromSseBuffer: (buffer: string) => {
        capturedSseBuffers.push(buffer);
        return null;
    },
    extractLikelyTextFromSsePayload: () => [],
    extractTitleFromSsePayload: () => null,
}));

mock.module('@/entrypoints/interceptor/stream-monitors/chatgpt-sse-monitor', () => ({
    monitorChatgptSseChunk: (chunkText: string, onChunk: (chunk: string) => void) => onChunk(chunkText),
}));

mock.module('@/entrypoints/interceptor/stream-monitors/stream-emitter', () => ({
    consumeReadableStreamChunks: async (
        _reader: ReadableStreamDefaultReader<Uint8Array>,
        _decoder: TextDecoder,
        _attemptId: string,
        _isAttemptDisposed: (id: string) => boolean,
        onChunk: (chunkText: string, chunkBytes: number) => void | Promise<void>,
    ) => {
        await onChunk(streamedChunk, streamedChunk.length);
    },
}));

import { monitorChatGptSseLifecycle } from './chatgpt-sse-lifecycle';

describe('chatgpt-sse-lifecycle buffer trimming', () => {
    const emit = {
        conversationIdResolved: () => {},
        lifecycle: () => {},
        streamDelta: () => {},
        streamDump: () => {},
        titleResolved: () => {},
        isAttemptDisposed: () => false,
        shouldLogTransient: () => false,
        log: () => {},
    };

    beforeEach(() => {
        capturedSseBuffers.length = 0;
        streamedChunk = '';
    });

    it('should keep trimmed adapter buffer aligned to an SSE frame boundary', async () => {
        const payload = 'x'.repeat(989);
        streamedChunk = `data: ${payload}\n\n`.repeat(520);

        await monitorChatGptSseLifecycle(new Response('seed'), 'attempt-1', emit as any);

        const lastBuffer = capturedSseBuffers[capturedSseBuffers.length - 1];
        expect(lastBuffer.length).toBeGreaterThan(0);
        expect(lastBuffer.startsWith('data: ')).toBeTrue();
    });
});
