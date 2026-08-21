export const RELAY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_RELAY_URL = 'http://127.0.0.1:4177/events';
export const MAX_RELAY_EVENT_BYTES = 32 * 1024;

const RELAY_EVENT_KINDS = [
    'stream-start',
    'stream-frame',
    'stream-end',
    'stream-export',
    'save-click',
    'save-state',
] as const;

const FRAME_KINDS = ['data', 'raw', 'raw_chunk', 'sse_event', 'ndjson_line', 'done', 'refusal', 'replacement', 'erase'] as const;
const FRAME_EVENTS = ['done', 'refusal', 'replacement', 'erase', 'close', 'abort', 'error'] as const;
const SAVE_STATES = ['idle', 'loading', 'success', 'error'] as const;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

type RelayEventKind = (typeof RELAY_EVENT_KINDS)[number];
type FrameKind = (typeof FRAME_KINDS)[number];
type FrameEvent = (typeof FRAME_EVENTS)[number];
type SaveState = (typeof SAVE_STATES)[number];
type HttpMethod = (typeof METHODS)[number];

export type RelayEvent = {
    schemaVersion: typeof RELAY_SCHEMA_VERSION;
    source: 'blackiya-dev-relay';
    capturedAt: number;
    kind: RelayEventKind;
    platform?: 'ChatGPT' | 'Gemini' | 'Grok';
    path?: string;
    method?: HttpMethod;
    streamId?: string;
    sequence?: number;
    frameKind?: FrameKind;
    event?: FrameEvent;
    bytes?: number;
    frameCount?: number;
    totalBytes?: number;
    status?: number;
    state?: SaveState;
    disabled?: boolean;
    streamCount?: number;
    truncated?: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isOneOf = <T extends readonly string[]>(value: unknown, values: T): value is T[number] =>
    typeof value === 'string' && values.includes(value);

const boundedInteger = (value: unknown, maximum: number): number | undefined => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return undefined;
    }
    return Math.min(value, maximum);
};

const boundedString = (value: unknown, maximum: number): string | undefined => {
    if (typeof value !== 'string' || value.length === 0) {
        return undefined;
    }
    return value.slice(0, maximum);
};

export const isLocalRelayUrl = (value: string): boolean => {
    try {
        const url = new URL(value);
        return (
            url.protocol === 'http:' &&
            (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
            url.pathname === '/events' &&
            !url.search &&
            !url.hash
        );
    } catch {
        return false;
    }
};

export const sanitizeRelayPath = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.length === 0) {
        return undefined;
    }
    try {
        const url = new URL(value, 'https://blackiya.invalid');
        return (url.pathname || '/').slice(0, 512);
    } catch {
        const path = value.split(/[?#]/, 1)[0];
        return path ? path.slice(0, 512) : undefined;
    }
};

const sanitizeCapturedAt = (value: unknown, now: number): number => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    return now;
};

const assignPlatformAndRequestFields = (event: RelayEvent, value: Record<string, unknown>) => {
    if (isOneOf(value.platform, ['ChatGPT', 'Gemini', 'Grok'] as const)) {
        event.platform = value.platform;
    }
    const path = sanitizeRelayPath(value.path ?? value.url);
    if (path) {
        event.path = path;
    }
    if (typeof value.method === 'string' && isOneOf(value.method.toUpperCase(), METHODS)) {
        event.method = value.method.toUpperCase() as HttpMethod;
    }
};

const assignStreamFields = (event: RelayEvent, value: Record<string, unknown>) => {
    const streamId = boundedString(value.streamId, 96);
    if (streamId && /^[a-zA-Z0-9:_-]+$/.test(streamId)) {
        event.streamId = streamId;
    }
    const sequence = boundedInteger(value.sequence, 1_000_000);
    if (sequence !== undefined) {
        event.sequence = sequence;
    }
    if (isOneOf(value.frameKind, FRAME_KINDS)) {
        event.frameKind = value.frameKind;
    }
    if (isOneOf(value.event, FRAME_EVENTS)) {
        event.event = value.event;
    }
    const bytes = boundedInteger(value.bytes, 64 * 1024 * 1024);
    if (bytes !== undefined) {
        event.bytes = bytes;
    }
    const frameCount = boundedInteger(value.frameCount, 1_000_000);
    if (frameCount !== undefined) {
        event.frameCount = frameCount;
    }
    const totalBytes = boundedInteger(value.totalBytes, 64 * 1024 * 1024);
    if (totalBytes !== undefined) {
        event.totalBytes = totalBytes;
    }
    const streamCount = boundedInteger(value.streamCount, 1_000);
    if (streamCount !== undefined) {
        event.streamCount = streamCount;
    }
    if (typeof value.truncated === 'boolean') {
        event.truncated = value.truncated;
    }
};

const assignSaveFields = (event: RelayEvent, value: Record<string, unknown>) => {
    if (typeof value.status === 'number' && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) {
        event.status = value.status;
    }
    if (isOneOf(value.state, SAVE_STATES)) {
        event.state = value.state;
    }
    if (typeof value.disabled === 'boolean') {
        event.disabled = value.disabled;
    }
};

export const sanitizeRelayEvent = (value: unknown, now = Date.now()): RelayEvent | null => {
    if (!isRecord(value) || !isOneOf(value.kind, RELAY_EVENT_KINDS)) {
        return null;
    }

    const event: RelayEvent = {
        schemaVersion: RELAY_SCHEMA_VERSION,
        source: 'blackiya-dev-relay',
        capturedAt: sanitizeCapturedAt(value.capturedAt, now),
        kind: value.kind,
    };

    assignPlatformAndRequestFields(event, value);
    assignStreamFields(event, value);
    assignSaveFields(event, value);

    return JSON.stringify(event).length <= MAX_RELAY_EVENT_BYTES ? event : null;
};

export const parseRelayNdjson = (body: string, now = Date.now()): RelayEvent[] => {
    if (typeof body !== 'string' || body.length > 2 * 1024 * 1024) {
        return [];
    }
    const events: RelayEvent[] = [];
    for (const line of body.split(/\r?\n/)) {
        if (line.trim().length === 0) {
            continue;
        }
        try {
            const event = sanitizeRelayEvent(JSON.parse(line), now);
            if (event) {
                events.push(event);
            }
        } catch {
            // The collector is best-effort for a debug stream; malformed lines are dropped.
        }
    }
    return events;
};
