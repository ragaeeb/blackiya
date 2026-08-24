export type StreamTransport = 'fetch' | 'xhr';
export type StreamDebugFrameKind =
    | 'data'
    | 'raw'
    | 'raw_chunk'
    | 'sse_event'
    | 'ndjson_line'
    | 'done'
    | 'refusal'
    | 'replacement'
    | 'erase'
    | 'transport';
export type StreamDebugFrameEvent = 'done' | 'refusal' | 'replacement' | 'erase' | 'close' | 'abort' | 'error';

export type StreamDebugFrame = {
    sequence: number;
    frameId: number;
    timestamp: number;
    kind: StreamDebugFrameKind;
    event?: StreamDebugFrameEvent;
    text: string;
    originalByteLength: number;
    storedByteLength: number;
    bytes: number;
    chunkByteLength?: number;
    metadata?: { chunkBytes: number };
    truncated: boolean;
};

export type StreamDebugTermination = {
    event: 'close' | 'abort' | 'error';
    at: number;
};

export type StreamDebugRecord = {
    streamId: string;
    platform: string;
    endpoint: string;
    method: string;
    transport: StreamTransport;
    path: string;
    startedAt: number;
    lastActivityAt: number;
    endedAt?: number;
    frames: StreamDebugFrame[];
    status: 'active' | 'closed' | 'aborted' | 'error';
    termination?: StreamDebugTermination;
    totalByteLength: number;
    totalRawBytes: number;
    totalRawFrames: number;
    droppedByteLength: number;
    truncatedBytes: number;
    droppedFrameCount: number;
    truncatedFrames: number;
    truncated: boolean;
};

export type StreamDebugStreamContext = {
    streamId?: string;
    platform: string;
    endpoint?: string;
    method: string;
    url: string;
    transport?: StreamTransport;
};

export type StreamDebugRecorderOptions = {
    now?: () => number;
    createStreamId?: () => string;
    maxStreams?: number;
    maxFramesPerStream?: number;
    ttlMs?: number;
    maxFrameBytes?: number;
    maxStreamBytes?: number;
    maxPerStreamBytes?: number;
    maxTotalBytes?: number;
    schedulePrune?: (callback: () => void, delayMs: number) => unknown;
    cancelPrune?: (handle: unknown) => void;
};

export type AppendStreamDebugFrameOptions = {
    kind?: StreamDebugFrameKind;
    event?: StreamDebugFrameEvent;
    chunkBytes?: number;
    metadata?: Record<string, unknown>;
};

export type StreamDebugFrameClassification = {
    kind?: StreamDebugFrameKind;
    event?: StreamDebugFrameEvent;
};

type StreamDebugFrameInput =
    | string
    | {
          text: string;
          kind?: StreamDebugFrameKind;
          event?: StreamDebugFrameEvent;
          bytes?: number;
          timestamp?: number;
          metadata?: Record<string, unknown>;
      };

export type StreamDebugRecorder = {
    startStream: (context: StreamDebugStreamContext) => string;
    appendFrame: (streamId: string, frame: StreamDebugFrameInput, options?: AppendStreamDebugFrameOptions) => boolean;
    terminateStream: (streamId: string, event: 'close' | 'abort' | 'error') => boolean;
    endStream: (streamId: string, status: 'closed' | 'aborted' | 'error', error?: unknown) => void;
    getStream: (streamId: string) => StreamDebugRecord | undefined;
    getAllStreams: (nowMs?: number) => StreamDebugRecord[];
    exportRecords: (nowMs?: number) => StreamDebugRecord[];
    clear: () => void;
    prune: (nowMs?: number) => number;
};

const DEFAULT_MAX_STREAMS = 64;
const DEFAULT_MAX_FRAMES_PER_STREAM = 512;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_MAX_STREAM_BYTES = 512 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

const encoder = new TextEncoder();
let streamIdCounter = 0;

const positiveInteger = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;

const byteLength = (text: string) => encoder.encode(text).byteLength;

const takeUtf8Prefix = (text: string, maxBytes: number): string => {
    if (maxBytes <= 0) {
        return '';
    }
    if (byteLength(text) <= maxBytes) {
        return text;
    }
    let low = 0;
    let high = text.length;
    while (low < high) {
        const midpoint = Math.ceil((low + high) / 2);
        if (byteLength(text.slice(0, midpoint)) <= maxBytes) {
            low = midpoint;
        } else {
            high = midpoint - 1;
        }
    }
    return text.slice(0, low);
};

const defaultStreamId = () => {
    streamIdCounter += 1;
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return `stream:${crypto.randomUUID()}`;
    }
    return `stream:${Date.now().toString(36)}:${streamIdCounter.toString(36)}`;
};

const defaultSchedulePrune = (callback: () => void, delayMs: number): unknown => {
    const handle = setTimeout(callback, delayMs);
    if (typeof handle === 'object' && handle && 'unref' in handle && typeof handle.unref === 'function') {
        handle.unref();
    }
    return handle;
};

const defaultCancelPrune = (handle: unknown): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
};

export const sanitizeStreamUrl = (url: string): string => {
    if (typeof url !== 'string' || url.length === 0) {
        return '';
    }
    try {
        return new URL(url, 'https://blackiya.invalid').pathname || '/';
    } catch {
        return url.split(/[?#]/, 1)[0] || '';
    }
};

const cloneRecord = (record: StreamDebugRecord & { nextSequence: number }): StreamDebugRecord => {
    const status = record.termination
        ? record.termination.event === 'close'
            ? 'closed'
            : record.termination.event === 'abort'
              ? 'aborted'
              : 'error'
        : (record.status ?? 'active');
    const { nextSequence: _nextSequence, ...publicRecord } = record;
    return {
        ...publicRecord,
        status,
        frames: record.frames.map((frame) => ({
            ...frame,
            ...(frame.metadata ? { metadata: { ...frame.metadata } } : {}),
        })),
    };
};

const safeChunkMetadata = (
    options: AppendStreamDebugFrameOptions,
): { chunkBytes?: number; metadata?: { chunkBytes: number } } => {
    const chunkBytes = options.chunkBytes ?? options.metadata?.chunkBytes;
    if (typeof chunkBytes !== 'number' || !Number.isFinite(chunkBytes) || chunkBytes < 0) {
        return {};
    }
    return { chunkBytes, metadata: { chunkBytes } };
};

const isNonNegativeFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;

const resolveFrameOptions = (
    frame: StreamDebugFrameInput,
    options: AppendStreamDebugFrameOptions | undefined,
): AppendStreamDebugFrameOptions => (typeof frame === 'object' ? { ...frame, ...options } : (options ?? {}));

const resolveFrameText = (frame: StreamDebugFrameInput): string | undefined =>
    typeof frame === 'string' ? frame : frame.text;

const resolveReportedByteLength = (
    frame: StreamDebugFrameInput,
    options: AppendStreamDebugFrameOptions,
    originalByteLength: number,
): number => {
    if (isNonNegativeFiniteNumber(options.chunkBytes)) {
        return options.chunkBytes;
    }
    if (typeof frame !== 'string' && isNonNegativeFiniteNumber(frame.bytes)) {
        return frame.bytes;
    }
    return originalByteLength;
};

type MutableStreamDebugRecord = StreamDebugRecord & { nextSequence: number };
type FramePriority = 0 | 1 | 2;

export const classifyStreamDebugFrame = (text: string): StreamDebugFrameClassification => {
    if (typeof text !== 'string') {
        return {};
    }

    const normalized = text.trim();
    const signalText = normalized.replace(/^(?:data:\s*)+/i, '').trim();
    if (/^\[DONE\]$/i.test(signalText)) {
        return { kind: 'done', event: 'done' };
    }

    const plainSignal =
        /^(?:(?:event|type|kind)\s*:\s*)?(refusal|replacement|replace|erase|erase_previous_tokens|delete)\s*$/i
            .exec(signalText)?.[1]
            ?.toLowerCase();
    if (plainSignal === 'refusal') {
        return { kind: 'refusal', event: 'refusal' };
    }
    if (plainSignal === 'replacement' || plainSignal === 'replace') {
        return { kind: 'replacement', event: 'replacement' };
    }
    if (plainSignal) {
        return { kind: 'erase', event: 'erase' };
    }

    if (
        /"action"\s*:\s*"(?:erase_previous_tokens|erase|delete)"/i.test(signalText) ||
        /"(?:erase|delete)"\s*:\s*(?:true|"|')/i.test(signalText)
    ) {
        return { kind: 'erase', event: 'erase' };
    }
    if (/("action"\s*:\s*"replace(?:ment)?"|"replacement"\s*:\s*(?:true|"|'))/i.test(signalText)) {
        return { kind: 'replacement', event: 'replacement' };
    }
    const refusalField = /"(?:refusal|refusal_reason)"\s*:\s*(?:true|"(?:\\.|[^"\\])+"|'(?:\\.|[^'\\])+')/i;
    if (
        /"is_refusal"\s*:\s*true/i.test(signalText) ||
        refusalField.test(signalText) ||
        /"finish_reason"\s*:\s*"refusal"/i.test(signalText) ||
        /"type"\s*:\s*"refusal"/i.test(signalText)
    ) {
        return { kind: 'refusal', event: 'refusal' };
    }
    return {};
};

const framePriority = (frame: Pick<StreamDebugFrame, 'kind' | 'event'>): FramePriority => {
    if (
        frame.event === 'done' ||
        frame.event === 'refusal' ||
        frame.event === 'replacement' ||
        frame.event === 'erase' ||
        frame.kind === 'done' ||
        frame.kind === 'refusal' ||
        frame.kind === 'replacement' ||
        frame.kind === 'erase'
    ) {
        return 2;
    }
    if (frame.event === 'close' || frame.event === 'abort' || frame.event === 'error' || frame.kind === 'transport') {
        return 1;
    }
    return 0;
};

const markInputTruncation = (record: MutableStreamDebugRecord, droppedByteLength: number) => {
    if (droppedByteLength <= 0) {
        return;
    }
    record.truncated = true;
    record.droppedByteLength += droppedByteLength;
    record.truncatedBytes += droppedByteLength;
    record.truncatedFrames += 1;
};

const markDroppedFrame = (record: MutableStreamDebugRecord, storedByteLength: number, wasAlreadyTruncated: boolean) => {
    record.truncated = true;
    record.droppedFrameCount += 1;
    record.droppedByteLength += storedByteLength;
    record.truncatedBytes += storedByteLength;
    if (!wasAlreadyTruncated) {
        record.truncatedFrames += 1;
    }
};

const markDroppedInput = (record: MutableStreamDebugRecord, rawByteLength: number) => {
    record.truncated = true;
    record.droppedFrameCount += 1;
    record.droppedByteLength += rawByteLength;
    record.truncatedBytes += rawByteLength;
    record.truncatedFrames += 1;
};

const resolveFrameKind = (
    text: string,
    options: AppendStreamDebugFrameOptions,
    event: StreamDebugFrameEvent | undefined,
) => options.kind ?? (event === 'done' ? 'done' : text.startsWith('data:') ? 'sse_event' : 'data');

type PreparedStreamFrame = {
    text: string;
    originalByteLength: number;
    rawByteLength: number;
    event?: StreamDebugFrameEvent;
    kind: StreamDebugFrameKind;
    incomingPriority: FramePriority;
    desiredByteLength: number;
    options: AppendStreamDebugFrameOptions;
};

const prepareStreamFrame = (
    frame: StreamDebugFrameInput,
    optionsForAppend: AppendStreamDebugFrameOptions | undefined,
    maxFrameBytes: number,
    maxStreamBytes: number,
    maxTotalBytes: number,
): PreparedStreamFrame | undefined => {
    const text = resolveFrameText(frame);
    if (typeof text !== 'string') {
        return undefined;
    }
    const options = resolveFrameOptions(frame, optionsForAppend);
    const originalByteLength = byteLength(text);
    const reportedByteLength = resolveReportedByteLength(frame, options, originalByteLength);
    const rawByteLength = Math.max(originalByteLength, reportedByteLength);
    const classification = classifyStreamDebugFrame(text);
    const event = options.event ?? classification.event;
    const kind = options.kind ?? classification.kind ?? resolveFrameKind(text, {}, event);
    return {
        text,
        originalByteLength,
        rawByteLength,
        event,
        kind,
        incomingPriority: framePriority({ kind, event }),
        desiredByteLength: Math.min(originalByteLength, maxFrameBytes, maxStreamBytes, maxTotalBytes),
        options,
    };
};

export const createStreamDebugRecorder = (options: StreamDebugRecorderOptions = {}): StreamDebugRecorder => {
    const now = options.now ?? Date.now;
    const createStreamId = options.createStreamId ?? defaultStreamId;
    const maxStreams = positiveInteger(options.maxStreams, DEFAULT_MAX_STREAMS);
    const maxFramesPerStream = positiveInteger(options.maxFramesPerStream, DEFAULT_MAX_FRAMES_PER_STREAM);
    const ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS);
    const maxFrameBytes = positiveInteger(options.maxFrameBytes ?? options.maxPerStreamBytes, DEFAULT_MAX_FRAME_BYTES);
    const maxStreamBytes = positiveInteger(
        options.maxStreamBytes ?? options.maxPerStreamBytes,
        DEFAULT_MAX_STREAM_BYTES,
    );
    const maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    const schedulePruneCallback = options.schedulePrune ?? defaultSchedulePrune;
    const cancelPruneCallback = options.cancelPrune ?? defaultCancelPrune;
    const records = new Map<string, MutableStreamDebugRecord>();
    let storedBytesTotal = 0;
    let pruneHandle: unknown | null = null;

    const removeRecord = (streamId: string) => {
        const record = records.get(streamId);
        if (!record) {
            return;
        }
        storedBytesTotal -= record.totalByteLength;
        records.delete(streamId);
    };

    const prune = (nowMs: number) => {
        for (const [streamId, record] of records) {
            if (nowMs - record.lastActivityAt >= ttlMs) {
                removeRecord(streamId);
            }
        }
    };

    const scheduleExpiryPrune = () => {
        if (pruneHandle !== null) {
            cancelPruneCallback(pruneHandle);
            pruneHandle = null;
        }
        if (records.size === 0) {
            return;
        }
        let earliestExpiry = Number.POSITIVE_INFINITY;
        for (const record of records.values()) {
            earliestExpiry = Math.min(earliestExpiry, record.lastActivityAt + ttlMs);
        }
        pruneHandle = schedulePruneCallback(() => {
            pruneHandle = null;
            prune(now());
            scheduleExpiryPrune();
        }, Math.max(0, earliestExpiry - now()));
    };

    const deleteOldest = () => {
        const oldest = records.keys().next().value;
        if (typeof oldest === 'string') {
            removeRecord(oldest);
        }
    };

    const removeFrame = (record: MutableStreamDebugRecord, index: number) => {
        const [removed] = record.frames.splice(index, 1);
        if (!removed) {
            return 0;
        }
        record.totalByteLength -= removed.storedByteLength;
        storedBytesTotal -= removed.storedByteLength;
        markDroppedFrame(record, removed.storedByteLength, removed.truncated);
        return removed.storedByteLength;
    };

    const findEvictionIndex = (record: MutableStreamDebugRecord, incomingPriority: FramePriority): number => {
        let candidateIndex = -1;
        let candidatePriority: FramePriority = 2;
        for (let index = 0; index < record.frames.length; index += 1) {
            const priority = framePriority(record.frames[index]!);
            if (priority > incomingPriority || priority > candidatePriority) {
                continue;
            }
            candidateIndex = index;
            candidatePriority = priority;
            if (priority === 0) {
                break;
            }
        }
        return candidateIndex;
    };

    const ensureFrameSlot = (record: MutableStreamDebugRecord, incomingPriority: FramePriority): boolean => {
        if (record.frames.length < maxFramesPerStream) {
            return true;
        }
        const index = findEvictionIndex(record, incomingPriority);
        if (index < 0) {
            return false;
        }
        removeFrame(record, index);
        return true;
    };

    const evictBytesFromRecord = (
        record: MutableStreamDebugRecord,
        bytesNeeded: number,
        incomingPriority: FramePriority,
    ) => {
        let remaining = bytesNeeded;
        while (remaining > 0) {
            const index = findEvictionIndex(record, incomingPriority);
            if (index < 0) {
                return;
            }
            const removedBytes = removeFrame(record, index);
            remaining -= removedBytes;
            if (removedBytes === 0 && record.frames.length === 0) {
                return;
            }
        }
    };

    type EvictionCandidate = {
        record: MutableStreamDebugRecord;
        index: number;
        priority: FramePriority;
    };

    const findGlobalEvictionCandidate = (
        preferredRecord: MutableStreamDebugRecord,
        incomingPriority: FramePriority,
    ): EvictionCandidate | undefined => {
        let candidate: EvictionCandidate | undefined;
        for (const record of records.values()) {
            const index = findEvictionIndex(record, incomingPriority);
            if (index < 0) {
                continue;
            }
            const priority = framePriority(record.frames[index]!);
            const preferred = record === preferredRecord;
            if (candidate && (priority > candidate.priority || (priority === candidate.priority && !preferred))) {
                continue;
            }
            candidate = { record, index, priority };
        }
        return candidate;
    };

    const evictBytesGlobally = (
        preferredRecord: MutableStreamDebugRecord,
        bytesNeeded: number,
        incomingPriority: FramePriority,
    ) => {
        let remaining = bytesNeeded;
        while (remaining > 0) {
            const candidate = findGlobalEvictionCandidate(preferredRecord, incomingPriority);
            if (!candidate) {
                return;
            }
            const removedBytes = removeFrame(candidate.record, candidate.index);
            remaining -= removedBytes;
            if (removedBytes === 0 && candidate.record.frames.length === 0) {
                return;
            }
        }
    };

    const availableStoredBytes = (record: MutableStreamDebugRecord) =>
        Math.max(0, Math.min(maxFrameBytes, maxStreamBytes - record.totalByteLength, maxTotalBytes - storedBytesTotal));

    const makeRoomFor = (
        record: MutableStreamDebugRecord,
        desiredByteLength: number,
        incomingPriority: FramePriority,
    ) => {
        if (incomingPriority === 0) {
            return;
        }
        const streamShortfall = desiredByteLength - (maxStreamBytes - record.totalByteLength);
        if (streamShortfall > 0) {
            evictBytesFromRecord(record, streamShortfall, incomingPriority);
        }

        const globalShortfall = desiredByteLength - (maxTotalBytes - storedBytesTotal);
        if (globalShortfall > 0) {
            evictBytesGlobally(record, globalShortfall, incomingPriority);
        }
    };

    const appendRetainedFrame = (
        record: MutableStreamDebugRecord,
        frame: PreparedStreamFrame,
        timestamp: number,
        storedText: string,
        storedByteLength: number,
    ) => {
        const droppedByteLength = Math.max(0, frame.rawByteLength - storedByteLength);
        markInputTruncation(record, droppedByteLength);
        const safeMetadata = safeChunkMetadata(frame.options);
        const nextSequence = record.nextSequence;
        record.nextSequence += 1;
        record.frames.push({
            sequence: nextSequence,
            frameId: nextSequence,
            timestamp,
            kind: frame.kind,
            ...(frame.event ? { event: frame.event } : {}),
            text: storedText,
            originalByteLength: frame.originalByteLength,
            storedByteLength,
            bytes: storedByteLength,
            ...(safeMetadata.chunkBytes === undefined ? {} : { chunkByteLength: safeMetadata.chunkBytes }),
            ...(safeMetadata.metadata ? { metadata: safeMetadata.metadata } : {}),
            truncated: droppedByteLength > 0,
        });
        record.totalByteLength += storedByteLength;
        storedBytesTotal += storedByteLength;
    };

    const startStream = (context: StreamDebugStreamContext): string => {
        if (!context || typeof context !== 'object') {
            return createStreamId();
        }
        const timestamp = now();
        prune(timestamp);
        while (records.size >= maxStreams) {
            deleteOldest();
        }
        let streamId = context.streamId ?? createStreamId();
        while (records.has(streamId)) {
            streamId = `${streamId}:duplicate`;
        }
        records.set(streamId, {
            streamId,
            platform: context.platform,
            endpoint: context.endpoint ?? 'generation',
            method: (context.method ?? 'GET').toUpperCase(),
            transport: context.transport ?? 'fetch',
            path: sanitizeStreamUrl(context.url),
            status: 'active',
            startedAt: timestamp,
            lastActivityAt: timestamp,
            frames: [],
            totalByteLength: 0,
            totalRawBytes: 0,
            totalRawFrames: 0,
            droppedByteLength: 0,
            droppedFrameCount: 0,
            truncatedBytes: 0,
            truncatedFrames: 0,
            truncated: false,
            nextSequence: 0,
        });
        scheduleExpiryPrune();
        return streamId;
    };

    const appendFrame = (
        streamId: string,
        frame: StreamDebugFrameInput,
        optionsForAppend?: AppendStreamDebugFrameOptions,
    ): boolean => {
        const timestamp = now();
        prune(timestamp);
        const record = records.get(streamId);
        if (!record || frame == null) {
            return false;
        }

        const preparedFrame = prepareStreamFrame(frame, optionsForAppend, maxFrameBytes, maxStreamBytes, maxTotalBytes);
        if (!preparedFrame) {
            return false;
        }

        record.totalRawBytes += preparedFrame.rawByteLength;
        record.totalRawFrames += 1;
        record.lastActivityAt = timestamp;

        if (!ensureFrameSlot(record, preparedFrame.incomingPriority)) {
            markDroppedInput(record, preparedFrame.rawByteLength);
            return true;
        }

        makeRoomFor(record, preparedFrame.desiredByteLength, preparedFrame.incomingPriority);
        const storedText = takeUtf8Prefix(preparedFrame.text, availableStoredBytes(record));
        const storedByteLength = byteLength(storedText);

        if (storedByteLength === 0 && preparedFrame.originalByteLength > 0) {
            markDroppedInput(record, preparedFrame.rawByteLength);
            return true;
        }

        appendRetainedFrame(record, preparedFrame, timestamp, storedText, storedByteLength);
        scheduleExpiryPrune();
        return true;
    };

    const terminateStream = (streamId: string, event: 'close' | 'abort' | 'error'): boolean => {
        const record = records.get(streamId);
        if (!record || record.termination) {
            return false;
        }
        const timestamp = now();
        record.lastActivityAt = timestamp;
        appendFrame(streamId, { text: '', kind: 'transport', event, timestamp });
        record.status = event === 'close' ? 'closed' : event === 'abort' ? 'aborted' : 'error';
        record.termination = { event, at: timestamp };
        record.endedAt = timestamp;
        scheduleExpiryPrune();
        return true;
    };

    const endStream = (streamId: string, status: 'closed' | 'aborted' | 'error', _error?: unknown) => {
        terminateStream(streamId, status === 'closed' ? 'close' : status === 'aborted' ? 'abort' : 'error');
    };

    const getAllStreams = (nowMs = now()): StreamDebugRecord[] => {
        prune(nowMs);
        return Array.from(records.values(), cloneRecord);
    };

    return {
        startStream,
        appendFrame,
        terminateStream,
        endStream,
        getStream: (streamId: string) => getAllStreams().find((record) => record.streamId === streamId),
        getAllStreams,
        exportRecords: getAllStreams,
        clear: () => {
            if (pruneHandle !== null) {
                cancelPruneCallback(pruneHandle);
                pruneHandle = null;
            }
            records.clear();
            storedBytesTotal = 0;
        },
        prune: (nowMs = now()) => {
            const before = records.size;
            prune(nowMs);
            return before - records.size;
        },
    };
};

export const streamDebugRecorder = createStreamDebugRecorder();
