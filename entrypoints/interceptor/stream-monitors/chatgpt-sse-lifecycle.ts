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

type SseChunkState = {
    lifecycleConversationId: string | undefined;
    sawContent: boolean;
    doneSignalSeen: boolean;
    streamBuffer: string;
    sseBufferForAdapter: string;
    lastDelta: string;
    sampledFrames: number;
    sampledFrameLimit: number;
};

const resolveConversationIdFromChunk = (chunk: string, currentConversationId?: string): string | undefined => {
    if (currentConversationId) {
        return currentConversationId;
    }
    const idMatch = chunk.match(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/i);
    return idMatch?.[0] ?? currentConversationId;
};

const processSseFrames = (
    state: SseChunkState,
    attemptId: string,
    emit: StreamMonitorEmitter,
    frames: string[],
): SseChunkState => {
    const nextState = { ...state };
    for (const frame of frames) {
        const dataPayload = extractSseDataPayload(frame);
        if (!dataPayload) {
            continue;
        }
        const result = processSseFrame(
            {
                attemptId,
                dataPayload,
                conversationId: nextState.lifecycleConversationId,
                sseBufferForAdapter: nextState.sseBufferForAdapter,
                lastDelta: nextState.lastDelta,
                sampledFrames: nextState.sampledFrames,
                sampledFrameLimit: nextState.sampledFrameLimit,
            },
            emit,
        );
        nextState.doneSignalSeen = nextState.doneSignalSeen || result.doneSignalSeen;
        nextState.sseBufferForAdapter = result.sseBufferForAdapter;
        nextState.lastDelta = result.lastDelta;
        nextState.sampledFrames = result.sampledFrames;
    }
    return nextState;
};

const processChunkText = (
    chunk: string,
    state: SseChunkState,
    attemptId: string,
    emit: StreamMonitorEmitter,
): SseChunkState => {
    const nextConversationId = resolveConversationIdFromChunk(chunk, state.lifecycleConversationId);
    if (!state.lifecycleConversationId && nextConversationId) {
        emit.conversationIdResolved(attemptId, nextConversationId, 'ChatGPT');
    }
    const shouldMarkStreaming = !state.sawContent && chunk.trim().length > 0;
    if (shouldMarkStreaming) {
        emit.lifecycle(attemptId, 'streaming', nextConversationId);
    }

    const combinedBuffer = state.streamBuffer + chunk;
    const { frames, remainingBuffer } = extractSseFramesFromBuffer(combinedBuffer);
    return processSseFrames(
        {
            ...state,
            lifecycleConversationId: nextConversationId,
            sawContent: state.sawContent || shouldMarkStreaming,
            streamBuffer: remainingBuffer,
        },
        attemptId,
        emit,
        frames,
    );
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

    let state: SseChunkState = {
        lifecycleConversationId: conversationId,
        sawContent: false,
        doneSignalSeen: false,
        streamBuffer: '',
        sseBufferForAdapter: '',
        lastDelta: '',
        sampledFrames: 0,
        sampledFrameLimit: 3,
    };

    if (state.lifecycleConversationId) {
        emit.conversationIdResolved(attemptId, state.lifecycleConversationId, 'ChatGPT');
    }

    try {
        await consumeReadableStreamChunks(reader, decoder, attemptId, emit.isAttemptDisposed, (chunkText) => {
            monitorChatgptSseChunk(chunkText, (chunk) => {
                state = processChunkText(chunk, state, attemptId, emit);
            });
        });
    } catch {
        // Ignore stream read errors; fallback completion signals handle final state.
    } finally {
        if (!state.doneSignalSeen && state.streamBuffer.includes('data: [DONE]')) {
            emit.lifecycle(attemptId, 'completed', state.lifecycleConversationId);
        }
        reader.releaseLock();
    }
};
