import {
    classifyStreamDebugFrame,
    type StreamDebugFrameKind,
    type StreamDebugRecorder,
} from '@/features/stream-debug/recorder';

export type StreamFraming = 'sse' | 'line' | 'raw';

export type MonitorFetchOptions = {
    framing?: StreamFraming;
    signal?: AbortSignal;
};

export const extractSseFrames = (buffer: string): { frames: string[]; remainder: string } => {
    const frames: string[] = [];
    let current = buffer;
    while (true) {
        const doubleNewlineUnix = current.indexOf('\n\n');
        const doubleNewlineWin = current.indexOf('\r\n\r\n');
        let splitIdx = -1;
        let sepLen = 2;

        if (doubleNewlineUnix >= 0 && doubleNewlineWin >= 0) {
            if (doubleNewlineUnix < doubleNewlineWin) {
                splitIdx = doubleNewlineUnix;
                sepLen = 2;
            } else {
                splitIdx = doubleNewlineWin;
                sepLen = 4;
            }
        } else if (doubleNewlineUnix >= 0) {
            splitIdx = doubleNewlineUnix;
            sepLen = 2;
        } else if (doubleNewlineWin >= 0) {
            splitIdx = doubleNewlineWin;
            sepLen = 4;
        }

        if (splitIdx < 0) {
            break;
        }

        const frame = current.slice(0, splitIdx);
        current = current.slice(splitIdx + sepLen);
        if (frame.trim().length > 0) {
            frames.push(frame.trim());
        }
    }
    return { frames, remainder: current };
};

export const extractLineFrames = (buffer: string): { frames: string[]; remainder: string } => {
    const frames: string[] = [];
    let current = buffer;
    while (true) {
        const newline = current.indexOf('\n');
        if (newline < 0) {
            break;
        }
        const line = current.slice(0, newline);
        current = current.slice(newline + 1);
        if (line.length > 0) {
            frames.push(line);
        }
    }
    return { frames, remainder: current };
};

export type StreamFrameAssembler = {
    push: (chunk: string) => string[];
    flush: () => string[];
};

const processAssemblerChunk = (framing: StreamFraming, buffer: string, chunk: string) => {
    const combined = buffer + chunk;
    const extracted = framing === 'sse' ? extractSseFrames(combined) : extractLineFrames(combined);
    const frames = [...extracted.frames];
    let remainder = extracted.remainder;

    while (textByteLength(remainder) > MAX_PENDING_FRAME_BYTES) {
        const prefix = takeUtf8Prefix(remainder, MAX_PENDING_FRAME_BYTES);
        if (!prefix) {
            break;
        }
        frames.push(prefix);
        remainder = remainder.slice(prefix.length);
    }

    return { frames, remainder };
};

export const createStreamFrameAssembler = (framing: StreamFraming = 'raw'): StreamFrameAssembler => {
    let buffer = '';
    return {
        push(chunk: string): string[] {
            if (!chunk) {
                return [];
            }
            if (framing === 'raw') {
                return [chunk];
            }

            const frames: string[] = [];
            for (let offset = 0; offset < chunk.length; offset += MAX_PENDING_FRAME_BYTES) {
                const result = processAssemblerChunk(
                    framing,
                    buffer,
                    chunk.slice(offset, offset + MAX_PENDING_FRAME_BYTES),
                );
                buffer = result.remainder;
                frames.push(...result.frames);
            }
            return frames;
        },
        flush(): string[] {
            if (!buffer) {
                return [];
            }
            const remaining = buffer;
            buffer = '';
            if (framing === 'sse' && remaining.trim().length > 0) {
                return [remaining.trim()];
            }
            if (framing === 'line' && remaining.length > 0) {
                return [remaining];
            }
            return [];
        },
    };
};

const appendClassifiedFrame = (
    streamId: string,
    frame: string,
    recorder: StreamDebugRecorder,
    fallbackKind: StreamDebugFrameKind,
) => {
    const classification = classifyStreamDebugFrame(frame);
    recorder.appendFrame(streamId, frame, {
        kind: classification.kind ?? fallbackKind,
        ...(classification.event ? { event: classification.event } : {}),
    });
};

type MonitorState = {
    framing: StreamFraming;
    decoder: TextDecoder;
    buffer: string;
};

const MAX_PENDING_FRAME_BYTES = 64 * 1024;
const textEncoder = new TextEncoder();

const textByteLength = (text: string) => textEncoder.encode(text).byteLength;

const takeUtf8Prefix = (text: string, maxBytes: number): string => {
    if (textByteLength(text) <= maxBytes) {
        return text;
    }
    let low = 0;
    let high = text.length;
    while (low < high) {
        const midpoint = Math.ceil((low + high) / 2);
        if (textByteLength(text.slice(0, midpoint)) <= maxBytes) {
            low = midpoint;
        } else {
            high = midpoint - 1;
        }
    }
    return text.slice(0, low);
};

const flushOversizedBuffer = (state: MonitorState, streamId: string, recorder: StreamDebugRecorder) => {
    while (textByteLength(state.buffer) > MAX_PENDING_FRAME_BYTES) {
        const prefix = takeUtf8Prefix(state.buffer, MAX_PENDING_FRAME_BYTES);
        if (!prefix) {
            return;
        }
        state.buffer = state.buffer.slice(prefix.length);
        recorder.appendFrame(streamId, prefix, { kind: 'raw_chunk' });
    }
};

const appendSseText = (text: string, state: MonitorState, streamId: string, recorder: StreamDebugRecorder) => {
    for (let offset = 0; offset < text.length; offset += MAX_PENDING_FRAME_BYTES) {
        state.buffer += text.slice(offset, offset + MAX_PENDING_FRAME_BYTES);
        const { frames, remainder } = extractSseFrames(state.buffer);
        state.buffer = remainder;
        for (const frame of frames) {
            appendClassifiedFrame(streamId, frame, recorder, 'sse_event');
        }
        flushOversizedBuffer(state, streamId, recorder);
    }
};

const appendLineText = (text: string, state: MonitorState, streamId: string, recorder: StreamDebugRecorder) => {
    for (let offset = 0; offset < text.length; offset += MAX_PENDING_FRAME_BYTES) {
        state.buffer += text.slice(offset, offset + MAX_PENDING_FRAME_BYTES);
        const { frames, remainder } = extractLineFrames(state.buffer);
        state.buffer = remainder;
        for (const frame of frames) {
            appendClassifiedFrame(streamId, frame, recorder, 'data');
        }
        flushOversizedBuffer(state, streamId, recorder);
    }
};

const appendDecodedChunk = (
    value: Uint8Array | undefined,
    state: MonitorState,
    streamId: string,
    recorder: StreamDebugRecorder,
) => {
    if (!value || value.length === 0) {
        return;
    }
    const chunkText = state.decoder.decode(value, { stream: true });
    if (!chunkText) {
        return;
    }
    if (state.framing === 'raw') {
        appendClassifiedFrame(streamId, chunkText, recorder, 'data');
    } else if (state.framing === 'sse') {
        appendSseText(chunkText, state, streamId, recorder);
    } else {
        appendLineText(chunkText, state, streamId, recorder);
    }
};

const flushMonitorBuffer = (state: MonitorState, streamId: string, recorder: StreamDebugRecorder) => {
    const remainingText = state.decoder.decode();
    if (remainingText) {
        if (state.framing === 'raw') {
            appendClassifiedFrame(streamId, remainingText, recorder, 'data');
        } else if (state.framing === 'sse') {
            appendSseText(remainingText, state, streamId, recorder);
        } else {
            appendLineText(remainingText, state, streamId, recorder);
        }
    }

    if (state.framing === 'sse' && state.buffer.trim().length > 0) {
        appendClassifiedFrame(streamId, state.buffer.trim(), recorder, 'sse_event');
    } else if (state.framing === 'line' && state.buffer.length > 0) {
        appendClassifiedFrame(streamId, state.buffer, recorder, 'data');
    }
    state.buffer = '';
};

const cancelReader = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    try {
        await reader.cancel();
    } catch {
        // Safe
    }
};

const consumeResponse = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    state: MonitorState,
    streamId: string,
    recorder: StreamDebugRecorder,
    signal?: AbortSignal,
): Promise<boolean> => {
    for (;;) {
        if (signal?.aborted) {
            await cancelReader(reader);
            return false;
        }

        const { value, done } = await reader.read();
        if (done) {
            break;
        }
        appendDecodedChunk(value, state, streamId, recorder);
    }

    flushMonitorBuffer(state, streamId, recorder);
    return !signal?.aborted;
};

export const monitorFetchResponse = async (
    response: Response,
    streamId: string,
    recorder: StreamDebugRecorder,
    options?: MonitorFetchOptions,
): Promise<void> => {
    if (!response.body) {
        recorder.terminateStream(streamId, 'close');
        return;
    }

    const state: MonitorState = {
        framing: options?.framing ?? 'sse',
        decoder: new TextDecoder(),
        buffer: '',
    };
    const signal = options?.signal;
    let terminated = false;

    const terminate = (event: 'close' | 'abort' | 'error') => {
        if (!terminated) {
            terminated = true;
            recorder.terminateStream(streamId, event);
        }
    };

    const reader = response.body.getReader();
    const abortHandler = () => {
        terminate('abort');
        void cancelReader(reader);
    };

    try {
        if (signal) {
            if (signal.aborted) {
                abortHandler();
                return;
            }
            signal.addEventListener('abort', abortHandler, { once: true });
        }

        if (await consumeResponse(reader, state, streamId, recorder, signal)) {
            terminate('close');
        } else {
            terminate('abort');
        }
    } catch (err: any) {
        if (signal?.aborted || err?.name === 'AbortError' || String(err).toLowerCase().includes('abort')) {
            terminate('abort');
        } else {
            terminate('error');
        }
    } finally {
        signal?.removeEventListener('abort', abortHandler);
        try {
            reader.releaseLock();
        } catch {
            // Safe
        }
    }
};
