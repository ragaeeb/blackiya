import { safePathname } from '@/entrypoints/interceptor/discovery';
import { normalizeGrokStreamChunk } from '@/entrypoints/interceptor/stream-monitors/grok-stream-monitor';
import { extractGrokStreamSignalsFromBuffer } from '@/utils/grok-stream-parser';
import { consumeReadableStreamChunks, type StreamMonitorEmitter } from './stream-emitter';

// Shared XHR state type

type GrokXhrStreamState = {
    attemptId: string;
    requestUrl: string;
    seedConversationId?: string;
    lastLength: number;
    buffer: string;
    seenPayloads: Set<string>;
    seenPayloadOrder: string[];
    emittedSignals: Set<string>;
    emittedSignalOrder: string[];
    emittedStreaming: boolean;
};

// History-trimming helpers

const trimPayloadHistory = (order: string[], set: Set<string>, max = 260) => {
    while (order.length > max) {
        const oldest = order.shift();
        if (oldest) {
            set.delete(oldest);
        }
    }
};

const trimSignalHistory = (order: string[], set: Set<string>, max = 360) => {
    while (order.length > max) {
        const oldest = order.shift();
        if (oldest) {
            set.delete(oldest);
        }
    }
};

// Buffer helpers

const appendGrokBuffer = (buffer: string, chunk: string): string => {
    const next = buffer + chunk;
    return next.length <= 1_000_000 ? next : next.slice(-800_000);
};

const appendSeenPayloads = (seenPayloadOrder: string[], seenPayloads: Set<string>, payloads: string[]) => {
    for (const payload of payloads) {
        seenPayloadOrder.push(payload);
    }
    trimPayloadHistory(seenPayloadOrder, seenPayloads);
};

// Candidate emission

const emitStreamCandidates = (
    attemptId: string,
    conversationId: string | undefined,
    textCandidates: string[],
    reasoningCandidates: string[],
    emittedSignals: Set<string>,
    emittedSignalOrder: string[],
    emit: StreamMonitorEmitter,
) => {
    const emitOne = (candidate: string, kind: 'text' | 'thinking') => {
        const normalized = candidate.replace(/\r\n/g, '\n');
        if (!normalized.trim()) {
            return;
        }
        const key = `${kind}:${normalized}`;
        if (emittedSignals.has(key)) {
            return;
        }
        emittedSignals.add(key);
        emittedSignalOrder.push(key);
        trimSignalHistory(emittedSignalOrder, emittedSignals);

        const text = kind === 'thinking' ? `[Thinking] ${normalized}` : normalized;
        emit.streamDelta(attemptId, conversationId, text, 'Grok');
        emit.streamDump(attemptId, conversationId, 'heuristic', text, text.length, 'Grok');
    };

    for (const c of textCandidates) {
        emitOne(c, 'text');
    }
    for (const c of reasoningCandidates) {
        emitOne(c, 'thinking');
    }
};

// Fetch stream monitor

const processFetchChunk = (
    attemptId: string,
    conversationId: string | undefined,
    emittedStreaming: boolean,
    emitLifecyclePhases: boolean,
    buffer: string,
    chunkText: string,
    chunkBytes: number,
    seenPayloads: Set<string>,
    seenPayloadOrder: string[],
    emittedSignals: Set<string>,
    emittedSignalOrder: string[],
    emit: StreamMonitorEmitter,
): { conversationId: string | undefined; emittedStreaming: boolean; buffer: string } => {
    const normalized = normalizeGrokStreamChunk(chunkText);

    if (emit.shouldLogTransient(`grok:fetch-stream:chunk:${attemptId}`, 7000)) {
        emit.log('info', 'Grok fetch stream progress', {
            attemptId,
            chunkBytes,
            conversationId: conversationId ?? null,
        });
    }

    emit.streamDump(attemptId, conversationId, 'delta', normalized, chunkBytes, 'Grok');
    buffer = appendGrokBuffer(buffer, normalized);

    const signals = extractGrokStreamSignalsFromBuffer(buffer, seenPayloads);
    buffer = signals.remainingBuffer;
    appendSeenPayloads(seenPayloadOrder, seenPayloads, signals.seenPayloadKeys);

    // Resolve conversation ID once
    if (!conversationId && signals.conversationId) {
        conversationId = signals.conversationId;
        emit.conversationIdResolved(attemptId, conversationId, 'Grok');
        if (emit.shouldLogTransient(`grok:fetch-stream:resolved:${attemptId}`, 7000)) {
            emit.log('info', 'Grok conversation resolved from stream', { attemptId, conversationId });
        }
    }

    if (
        emitLifecyclePhases &&
        !emittedStreaming &&
        (signals.textCandidates.length > 0 || signals.reasoningCandidates.length > 0 || normalized.trim().length > 0)
    ) {
        emit.lifecycle(attemptId, 'streaming', conversationId, 'Grok');
        emittedStreaming = true;
    }

    emitStreamCandidates(
        attemptId,
        conversationId,
        signals.textCandidates,
        signals.reasoningCandidates,
        emittedSignals,
        emittedSignalOrder,
        emit,
    );

    if (emit.shouldLogTransient(`grok:fetch-stream:signals:${attemptId}`, 7000)) {
        const total = signals.textCandidates.length + signals.reasoningCandidates.length;
        if (total > 0) {
            emit.log('info', 'Grok stream candidates emitted', {
                attemptId,
                conversationId: conversationId ?? null,
                textCandidates: signals.textCandidates.length,
                reasoningCandidates: signals.reasoningCandidates.length,
            });
        }
    }

    return { conversationId, emittedStreaming, buffer };
};

/** Attaches to a cloned Grok fetch response stream and emits NDJSON-parsed signals. */
export const monitorGrokResponseStream = async (
    response: Response,
    attemptId: string,
    emit: StreamMonitorEmitter,
    seedConversationId: string | undefined,
    requestUrl: string,
    emitLifecyclePhases: boolean,
) => {
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
    const emittedSignals = new Set<string>();
    const emittedSignalOrder: string[] = [];

    if (conversationId) {
        emit.conversationIdResolved(attemptId, conversationId, 'Grok');
    }
    if (emit.shouldLogTransient(`grok:fetch-stream:start:${attemptId}`, 8000)) {
        emit.log('info', 'Grok fetch stream monitor start', {
            attemptId,
            conversationId: conversationId ?? null,
            path: safePathname(requestUrl),
        });
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
                    emitLifecyclePhases,
                    buffer,
                    chunkText,
                    chunkBytes,
                    seenPayloads,
                    seenPayloadOrder,
                    emittedSignals,
                    emittedSignalOrder,
                    emit,
                );
                conversationId = result.conversationId;
                emittedStreaming = result.emittedStreaming;
                buffer = result.buffer;
            },
        );
    } catch {
        // Canonical capture path remains authoritative.
    } finally {
        reader.releaseLock();
    }
};

// XHR progress monitor

const createXhrStreamState = (
    attemptId: string,
    requestUrl: string,
    seedConversationId?: string,
): GrokXhrStreamState => ({
    attemptId,
    requestUrl,
    seedConversationId,
    lastLength: 0,
    buffer: '',
    seenPayloads: new Set(),
    seenPayloadOrder: [],
    emittedSignals: new Set(),
    emittedSignalOrder: [],
    emittedStreaming: false,
});

const processXhrChunk = (state: GrokXhrStreamState, chunkText: string, emit: StreamMonitorEmitter) => {
    if (!chunkText || emit.isAttemptDisposed(state.attemptId)) {
        return;
    }

    if (emit.shouldLogTransient(`grok:xhr-stream:chunk:${state.attemptId}`, 7000)) {
        emit.log('info', 'Grok XHR stream progress', {
            attemptId: state.attemptId,
            chunkBytes: chunkText.length,
            conversationId: state.seedConversationId ?? null,
        });
    }

    emit.streamDump(state.attemptId, state.seedConversationId, 'delta', chunkText, chunkText.length, 'Grok');
    state.buffer = appendGrokBuffer(state.buffer, chunkText);

    const signals = extractGrokStreamSignalsFromBuffer(state.buffer, state.seenPayloads);
    state.buffer = signals.remainingBuffer;
    appendSeenPayloads(state.seenPayloadOrder, state.seenPayloads, signals.seenPayloadKeys);

    const resolvedId = signals.conversationId ?? state.seedConversationId;
    if (!state.seedConversationId && resolvedId) {
        state.seedConversationId = resolvedId;
        emit.conversationIdResolved(state.attemptId, resolvedId, 'Grok');
        if (emit.shouldLogTransient(`grok:xhr-stream:resolved:${state.attemptId}`, 7000)) {
            emit.log('info', 'Grok XHR conversation resolved from stream', {
                attemptId: state.attemptId,
                conversationId: resolvedId,
            });
        }
    }

    if (
        !state.emittedStreaming &&
        (signals.textCandidates.length > 0 || signals.reasoningCandidates.length > 0 || chunkText.trim().length > 0)
    ) {
        state.emittedStreaming = true;
        emit.lifecycle(state.attemptId, 'streaming', resolvedId, 'Grok');
    }

    emitStreamCandidates(
        state.attemptId,
        resolvedId,
        signals.textCandidates,
        signals.reasoningCandidates,
        state.emittedSignals,
        state.emittedSignalOrder,
        emit,
    );
};

/**
 * Attaches progress/loadend listeners to a Grok XHR request and drives
 * NDJSON stream parsing.
 */
export const wireGrokXhrProgressMonitor = (
    xhr: XMLHttpRequest,
    attemptId: string,
    emit: StreamMonitorEmitter,
    seedConversationId: string | undefined,
    requestUrl: string,
) => {
    if (emit.shouldLogTransient(`grok:xhr-stream:start:${attemptId}`, 7000)) {
        emit.log('info', 'Grok XHR stream monitor start', { attemptId, conversationId: seedConversationId ?? null });
    }

    const state = createXhrStreamState(attemptId, requestUrl, seedConversationId);

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
        if (emit.shouldLogTransient(`grok:xhr-stream:end:${state.attemptId}`, 7000)) {
            emit.log('info', 'Grok XHR stream monitor complete', {
                attemptId: state.attemptId,
                conversationId: state.seedConversationId ?? null,
                path: safePathname(state.requestUrl),
            });
        }
        xhr.removeEventListener('progress', flushProgress);
        xhr.removeEventListener('loadend', handleLoadEnd);
    };

    xhr.addEventListener('progress', flushProgress);
    xhr.addEventListener('loadend', handleLoadEnd);
};
