import { monitorChatgptSseChunk } from '@/entrypoints/interceptor/stream-monitors/chatgpt-sse-monitor';
import {
    extractAssistantTextSnapshotFromSseBuffer,
    extractLikelyTextFromSsePayload,
    extractTitleFromSsePayload,
} from '@/entrypoints/interceptor/text-extraction';
import { consumeReadableStreamChunks, type StreamMonitorEmitter } from './stream-emitter';

// ---------------------------------------------------------------------------
// SSE frame parsing
// ---------------------------------------------------------------------------

const extractSseFramesFromBuffer = (buffer: string): { frames: string[]; remainingBuffer: string } => {
    const frames: string[] = [];
    let remaining = buffer;
    let idx = remaining.indexOf('\n\n');
    while (idx >= 0) {
        frames.push(remaining.slice(0, idx));
        remaining = remaining.slice(idx + 2);
        idx = remaining.indexOf('\n\n');
    }
    return { frames, remainingBuffer: remaining };
};

const extractSseDataPayload = (frame: string): string =>
    frame
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
        .trim();

// ---------------------------------------------------------------------------
// Per-frame processing
// ---------------------------------------------------------------------------

const appendAdapterBuffer = (buf: string, dataPayload: string): string => {
    const next = `${buf}data: ${dataPayload}\n\n`;
    return next.length <= 400_000 ? next : next.slice(-250_000);
};

type SseFrameContext = {
    attemptId: string;
    dataPayload: string;
    conversationId: string | undefined;
    sseBufferForAdapter: string;
    lastDelta: string;
    sampledFrames: number;
    sampledFrameLimit: number;
};

type SseFrameResult = {
    doneSignalSeen: boolean;
    sseBufferForAdapter: string;
    lastDelta: string;
    sampledFrames: number;
};

const processSseFrame = (context: SseFrameContext, emit: StreamMonitorEmitter): SseFrameResult => {
    const { attemptId, dataPayload, conversationId } = context;
    let { sseBufferForAdapter, lastDelta, sampledFrames } = context;

    if (dataPayload === '[DONE]') {
        emit.lifecycle(attemptId, 'completed', conversationId);
        return { doneSignalSeen: true, sseBufferForAdapter, lastDelta, sampledFrames };
    }

    // Title signal
    const title = extractTitleFromSsePayload(dataPayload);
    if (title && conversationId) {
        emit.titleResolved(attemptId, conversationId, title);
    }

    sseBufferForAdapter = appendAdapterBuffer(sseBufferForAdapter, dataPayload);

    // Prefer adapter-parsed snapshot over heuristic token extraction
    const snapshot = extractAssistantTextSnapshotFromSseBuffer(sseBufferForAdapter);
    if (snapshot && snapshot !== lastDelta) {
        emit.streamDelta(attemptId, conversationId, snapshot);
        emit.streamDump(attemptId, conversationId, 'snapshot', snapshot, dataPayload.length);
        lastDelta = snapshot;
    } else if (!snapshot) {
        for (const candidate of extractLikelyTextFromSsePayload(dataPayload)) {
            if (candidate === lastDelta) {
                continue;
            }
            lastDelta = candidate;
            emit.streamDelta(attemptId, conversationId, candidate);
            emit.streamDump(attemptId, conversationId, 'heuristic', candidate, dataPayload.length);
        }

        if (sampledFrames < context.sampledFrameLimit) {
            emit.log('info', 'stream frame sample', {
                conversationId: conversationId ?? null,
                bytes: dataPayload.length,
                preview: dataPayload.slice(0, 220),
            });
            sampledFrames += 1;
        }
    }

    return { doneSignalSeen: false, sseBufferForAdapter, lastDelta, sampledFrames };
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attaches to a cloned ChatGPT SSE response stream and emits lifecycle,
 * stream-delta, and title signals as frames arrive.
 */
export const monitorChatGptSseLifecycle = async (
    response: Response,
    attemptId: string,
    emit: StreamMonitorEmitter,
    conversationId?: string,
): Promise<void> => {
    if (!response.body) {
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let lifecycleConversationId = conversationId;
    let sawContent = false;
    let doneSignalSeen = false;
    let streamBuffer = '';
    let sseBufferForAdapter = '';
    let lastDelta = '';
    let sampledFrames = 0;
    const sampledFrameLimit = 3;

    if (lifecycleConversationId) {
        emit.conversationIdResolved(attemptId, lifecycleConversationId, 'ChatGPT');
    }

    try {
        await consumeReadableStreamChunks(reader, decoder, attemptId, emit.isAttemptDisposed, (chunkText) => {
            monitorChatgptSseChunk(chunkText, (chunk) => {
                // Conversation ID resolution from stream content
                if (!lifecycleConversationId) {
                    const idMatch = chunk.match(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/i);
                    if (idMatch?.[0]) {
                        lifecycleConversationId = idMatch[0];
                        emit.conversationIdResolved(attemptId, lifecycleConversationId, 'ChatGPT');
                    }
                }

                // Streaming lifecycle on first non-empty chunk
                if (!sawContent && chunk.trim().length > 0) {
                    emit.lifecycle(attemptId, 'streaming', lifecycleConversationId);
                    sawContent = true;
                }

                streamBuffer += chunk;
                const { frames, remainingBuffer } = extractSseFramesFromBuffer(streamBuffer);
                streamBuffer = remainingBuffer;

                for (const frame of frames) {
                    const dataPayload = extractSseDataPayload(frame);
                    if (!dataPayload) {
                        continue;
                    }

                    const result = processSseFrame(
                        {
                            attemptId,
                            dataPayload,
                            conversationId: lifecycleConversationId,
                            sseBufferForAdapter,
                            lastDelta,
                            sampledFrames,
                            sampledFrameLimit,
                        },
                        emit,
                    );

                    doneSignalSeen = doneSignalSeen || result.doneSignalSeen;
                    sseBufferForAdapter = result.sseBufferForAdapter;
                    lastDelta = result.lastDelta;
                    sampledFrames = result.sampledFrames;
                }
            });
        });
    } catch {
        // Ignore stream read errors; fallback completion signals handle final state.
    } finally {
        if (!doneSignalSeen && streamBuffer.includes('data: [DONE]')) {
            emit.lifecycle(attemptId, 'completed', lifecycleConversationId);
        }
        reader.releaseLock();
    }
};
