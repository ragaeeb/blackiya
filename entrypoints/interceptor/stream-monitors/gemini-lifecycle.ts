import { tryMarkGeminiXhrLoadendCompleted } from '@/entrypoints/interceptor/signal-emitter';
import { shouldProcessGeminiChunk } from '@/entrypoints/interceptor/stream-monitors/gemini-stream-monitor';
import { extractGeminiStreamSignalsFromBuffer } from '@/utils/gemini-stream-parser';
import { consumeReadableStreamChunks, type StreamMonitorEmitter } from './stream-emitter';

// Shared types

export type GeminiXhrStreamState = {
    attemptId: string;
    seedConversationId?: string;
    lastLength: number;
    buffer: string;
    seenPayloads: Set<string>;
    seenPayloadOrder: string[];
    emittedText: Set<string>;
    emittedTextOrder: string[];
    emittedTitles: Set<string>;
    emittedStreaming: boolean;
    emittedCompleted: boolean;
};

// Shared history-trimming helpers

const trimPayloadHistory = (order: string[], set: Set<string>, max = 220): void => {
    while (order.length > max) {
        const oldest = order.shift();
        if (oldest) {
            set.delete(oldest);
        }
    }
};

const trimDeltaHistory = (order: string[], set: Set<string>, max = 260): void => {
    while (order.length > max) {
        const oldest = order.shift();
        if (oldest) {
            set.delete(oldest);
        }
    }
};

// Buffer helpers

const appendGeminiBuffer = (buffer: string, chunk: string): string => {
    const next = buffer + chunk;
    return next.length <= 900_000 ? next : next.slice(-700_000);
};

const syncSeenPayloadOrder = (seenPayloads: Set<string>, seenPayloadOrder: string[]): void => {
    for (const payload of seenPayloads) {
        if (!seenPayloadOrder.includes(payload)) {
            seenPayloadOrder.push(payload);
        }
    }
    trimPayloadHistory(seenPayloadOrder, seenPayloads);
};

// Candidate emission helpers

const emitTextCandidates = (
    attemptId: string,
    conversationId: string | undefined,
    candidates: string[],
    emittedText: Set<string>,
    emittedTextOrder: string[],
    emit: StreamMonitorEmitter,
    platform: string,
): void => {
    for (const candidate of candidates) {
        if (emittedText.has(candidate)) {
            continue;
        }
        emittedText.add(candidate);
        emittedTextOrder.push(candidate);
        trimDeltaHistory(emittedTextOrder, emittedText);
        emit.streamDelta(attemptId, conversationId, candidate, platform);
        emit.streamDump(attemptId, conversationId, 'heuristic', candidate, candidate.length, platform);
        if (emit.shouldLogTransient(`gemini:stream:candidate:${attemptId}`, 6000)) {
            emit.log('info', 'Gemini stream candidate emitted', {
                attemptId,
                conversationId: conversationId ?? null,
                length: candidate.length,
                preview: candidate.slice(0, 120),
            });
        }
    }
};

const emitTitleCandidates = (
    attemptId: string,
    conversationId: string | undefined,
    titleCandidates: string[],
    emittedTitles: Set<string>,
    emit: StreamMonitorEmitter,
): void => {
    if (!conversationId) {
        return;
    }
    for (const title of titleCandidates) {
        const normalized = title.trim();
        if (!normalized || emittedTitles.has(normalized)) {
            continue;
        }
        emittedTitles.add(normalized);
        emit.titleResolved(attemptId, conversationId, normalized, 'Gemini');
        if (emit.shouldLogTransient(`gemini:title:emitted:${attemptId}`, 6000)) {
            emit.log('info', 'Gemini stream title emitted', { attemptId, conversationId, title: normalized });
        }
    }
};

// Fetch stream monitor

const processFetchChunk = (
    attemptId: string,
    conversationId: string | undefined,
    emittedStreaming: boolean,
    buffer: string,
    chunkText: string,
    chunkBytes: number,
    seenPayloads: Set<string>,
    seenPayloadOrder: string[],
    emittedText: Set<string>,
    emittedTextOrder: string[],
    emittedTitles: Set<string>,
    emit: StreamMonitorEmitter,
): { conversationId: string | undefined; emittedStreaming: boolean; buffer: string } => {
    if (!shouldProcessGeminiChunk(chunkText)) {
        return { conversationId, emittedStreaming, buffer };
    }

    if (emit.shouldLogTransient(`gemini:fetch-stream:chunk:${attemptId}`, 8000)) {
        emit.log('info', 'Gemini fetch stream progress', {
            attemptId,
            chunkBytes,
            conversationId: conversationId ?? null,
        });
    }

    buffer = appendGeminiBuffer(buffer, chunkText);
    emit.streamDump(attemptId, conversationId, 'delta', chunkText, chunkBytes, 'Gemini');

    const {
        conversationId: parsedId,
        textCandidates,
        titleCandidates,
    } = extractGeminiStreamSignalsFromBuffer(buffer, seenPayloads);
    syncSeenPayloadOrder(seenPayloads, seenPayloadOrder);

    // Resolve conversation ID once
    if (!conversationId && parsedId) {
        conversationId = parsedId;
        emit.conversationIdResolved(attemptId, parsedId, 'Gemini');
        if (emit.shouldLogTransient(`gemini:fetch-stream:resolved:${attemptId}`, 8000)) {
            emit.log('info', 'Gemini conversation resolved from stream', { attemptId, conversationId: parsedId });
        }
    }

    if (!emittedStreaming && (textCandidates.length > 0 || chunkText.trim().length > 0)) {
        emit.lifecycle(attemptId, 'streaming', conversationId, 'Gemini');
        emittedStreaming = true;
    }

    emitTextCandidates(attemptId, conversationId, textCandidates, emittedText, emittedTextOrder, emit, 'Gemini');
    emitTitleCandidates(attemptId, conversationId, titleCandidates, emittedTitles, emit);

    return { conversationId, emittedStreaming, buffer };
};

/** Attaches to a cloned Gemini fetch response stream and emits streaming signals. */
export const monitorGeminiResponseStream = async (
    response: Response,
    attemptId: string,
    emit: StreamMonitorEmitter,
    seedConversationId?: string,
): Promise<void> => {
    if (!response.body || emit.isAttemptDisposed(attemptId)) {
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let conversationId = seedConversationId;
    let emittedStreaming = false;
    const seenPayloads = new Set<string>();
    const seenPayloadOrder: string[] = [];
    const emittedText = new Set<string>();
    const emittedTextOrder: string[] = [];
    const emittedTitles = new Set<string>();

    if (conversationId) {
        emit.conversationIdResolved(attemptId, conversationId, 'Gemini');
    }
    if (emit.shouldLogTransient(`gemini:fetch-stream:start:${attemptId}`, 8000)) {
        emit.log('info', 'Gemini fetch stream monitor start', { attemptId, conversationId: conversationId ?? null });
    }

    try {
        await consumeReadableStreamChunks(
            reader,
            decoder,
            attemptId,
            emit.isAttemptDisposed,
            (chunkText, chunkBytes) => {
                const result = processFetchChunk(
                    attemptId,
                    conversationId,
                    emittedStreaming,
                    buffer,
                    chunkText,
                    chunkBytes,
                    seenPayloads,
                    seenPayloadOrder,
                    emittedText,
                    emittedTextOrder,
                    emittedTitles,
                    emit,
                );
                conversationId = result.conversationId;
                emittedStreaming = result.emittedStreaming;
                buffer = result.buffer;
            },
        );
    } catch {
        // Completion and canonical capture paths remain authoritative.
    } finally {
        reader.releaseLock();
    }
};

// XHR progress monitor

const createXhrStreamState = (attemptId: string, seedConversationId?: string): GeminiXhrStreamState => ({
    attemptId,
    seedConversationId,
    lastLength: 0,
    buffer: '',
    seenPayloads: new Set(),
    seenPayloadOrder: [],
    emittedText: new Set(),
    emittedTextOrder: [],
    emittedTitles: new Set(),
    emittedStreaming: false,
    emittedCompleted: false,
});

const processXhrChunk = (state: GeminiXhrStreamState, chunkText: string, emit: StreamMonitorEmitter): void => {
    if (!chunkText || emit.isAttemptDisposed(state.attemptId)) {
        return;
    }

    if (emit.shouldLogTransient(`gemini:xhr-stream:chunk:${state.attemptId}`, 8000)) {
        emit.log('info', 'Gemini XHR stream progress', {
            attemptId: state.attemptId,
            chunkBytes: chunkText.length,
            conversationId: state.seedConversationId ?? null,
        });
    }

    state.buffer = appendGeminiBuffer(state.buffer, chunkText);
    emit.streamDump(state.attemptId, state.seedConversationId, 'delta', chunkText, chunkText.length, 'Gemini');

    const signals = extractGeminiStreamSignalsFromBuffer(state.buffer, state.seenPayloads);
    syncSeenPayloadOrder(state.seenPayloads, state.seenPayloadOrder);

    const resolvedId = signals.conversationId ?? state.seedConversationId;
    if (!state.seedConversationId && resolvedId) {
        state.seedConversationId = resolvedId;
        emit.conversationIdResolved(state.attemptId, resolvedId, 'Gemini');
        if (emit.shouldLogTransient(`gemini:xhr-stream:resolved:${state.attemptId}`, 8000)) {
            emit.log('info', 'Gemini XHR conversation resolved from stream', {
                attemptId: state.attemptId,
                conversationId: resolvedId,
            });
        }
    }

    if (!state.emittedStreaming && (signals.textCandidates.length > 0 || chunkText.trim().length > 0)) {
        state.emittedStreaming = true;
        emit.lifecycle(state.attemptId, 'streaming', resolvedId, 'Gemini');
    }

    emitTextCandidates(
        state.attemptId,
        resolvedId,
        signals.textCandidates,
        state.emittedText,
        state.emittedTextOrder,
        emit,
        'Gemini',
    );
    emitTitleCandidates(state.attemptId, resolvedId, signals.titleCandidates, state.emittedTitles, emit);
};

/**
 * Attaches progress/loadend listeners to a Gemini XHR request and drives the
 * stream state machine. Emits a `completed` lifecycle signal on clean load.
 */
export const wireGeminiXhrProgressMonitor = (
    xhr: XMLHttpRequest,
    attemptId: string,
    emit: StreamMonitorEmitter,
    seedConversationId: string | undefined,
    requestUrl: string,
): void => {
    if (emit.shouldLogTransient(`gemini:xhr-stream:start:${attemptId}`, 8000)) {
        emit.log('info', 'Gemini XHR stream monitor start', {
            attemptId,
            conversationId: seedConversationId ?? null,
        });
    }

    const state = createXhrStreamState(attemptId, seedConversationId);

    const flushProgress = () => {
        if (typeof xhr.responseText !== 'string' || xhr.responseText.length <= state.lastLength) {
            return;
        }
        const chunk = xhr.responseText.slice(state.lastLength);
        state.lastLength = xhr.responseText.length;
        processXhrChunk(state, chunk, emit);
    };

    const handleLoadEnd = () => {
        flushProgress();
        if (
            !emit.isAttemptDisposed(state.attemptId) &&
            xhr.readyState === XMLHttpRequest.DONE &&
            xhr.status >= 200 &&
            xhr.status < 300 &&
            tryMarkGeminiXhrLoadendCompleted(state, requestUrl)
        ) {
            emit.lifecycle(state.attemptId, 'completed', state.seedConversationId, 'Gemini');
        }
        xhr.removeEventListener('progress', flushProgress);
        xhr.removeEventListener('loadend', handleLoadEnd);
    };

    xhr.addEventListener('progress', flushProgress);
    xhr.addEventListener('loadend', handleLoadEnd);
};
