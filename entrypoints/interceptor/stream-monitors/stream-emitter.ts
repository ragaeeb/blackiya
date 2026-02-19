import type { ResponseLifecycleMessage, StreamDumpFrameMessage } from '@/utils/protocol/messages';

export type StreamLifecyclePhase = ResponseLifecycleMessage['phase'];

/**
 * Callback bundle passed into stream lifecycle monitors so they remain fully
 * decoupled from bootstrap-level state (caches, maps, token stamping).
 *
 * Bootstrap creates a concrete instance that closes over its module-level caches.
 */
export type StreamMonitorEmitter = {
    conversationIdResolved: (attemptId: string, conversationId: string, platform: string) => void;
    lifecycle: (attemptId: string, phase: StreamLifecyclePhase, conversationId?: string, platform?: string) => void;
    streamDelta: (attemptId: string, conversationId: string | undefined, text: string, platform?: string) => void;
    streamDump: (
        attemptId: string,
        conversationId: string | undefined,
        kind: StreamDumpFrameMessage['kind'],
        text: string,
        chunkBytes?: number,
        platform?: string,
    ) => void;
    titleResolved: (attemptId: string, conversationId: string, title: string, platform?: string) => void;
    isAttemptDisposed: (attemptId: string) => boolean;
    shouldLogTransient: (key: string, intervalMs?: number) => boolean;
    log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
};

/**
 * Drains a `ReadableStreamDefaultReader` chunk-by-chunk, calling `onChunk`
 * for each decoded text fragment. Bails early if the attempt is disposed.
 */
export const consumeReadableStreamChunks = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    attemptId: string,
    isAttemptDisposed: (id: string) => boolean,
    onChunk: (chunkText: string, chunkBytes: number) => void | Promise<void>,
): Promise<void> => {
    while (true) {
        if (isAttemptDisposed(attemptId)) {
            return;
        }
        const { value, done } = await reader.read();
        if (done) {
            return;
        }
        if (!value || value.length === 0) {
            continue;
        }
        const chunkText = decoder.decode(value, { stream: true });
        if (chunkText.length > 0) {
            await onChunk(chunkText, value.length);
        }
    }
};
