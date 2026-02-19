import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/utils/settings';

type StorageBackend = {
    get: (key: string) => Promise<Record<string, unknown>>;
    set: (value: Record<string, unknown>) => Promise<void>;
    remove: (key: string) => Promise<void>;
};

const createInMemoryStorage = (): StorageBackend => {
    const store = new Map<string, unknown>();
    return {
        async get(key: string) {
            return { [key]: store.get(key) };
        },
        async set(value: Record<string, unknown>) {
            for (const [k, v] of Object.entries(value)) {
                store.set(k, v);
            }
        },
        async remove(key: string) {
            store.delete(key);
        },
    };
};

export type StreamDumpFrameKind = 'snapshot' | 'heuristic' | 'delta' | 'lifecycle';

export type StreamDumpFrameInput = {
    platform: string;
    attemptId: string;
    conversationId?: string | null;
    kind: StreamDumpFrameKind;
    text: string;
    chunkBytes?: number;
    frameIndex?: number;
    timestampMs?: number;
};

export type StreamDumpFrame = {
    timestamp: string;
    platform: string;
    attemptId: string;
    conversationId: string | null;
    kind: StreamDumpFrameKind;
    text: string;
    chunkBytes?: number;
    frameIndex?: number;
};

export type StreamDumpSession = {
    attemptId: string;
    platform: string;
    conversationId: string | null;
    startedAt: string;
    updatedAt: string;
    frameCount: number;
    truncated: boolean;
    frames: StreamDumpFrame[];
};

export type StreamDumpStore = {
    schemaVersion: 1;
    createdAt: string;
    updatedAt: string;
    sessions: StreamDumpSession[];
};

type StreamDumpOptions = {
    flushThreshold?: number;
    flushIntervalMs?: number;
    maxSessions?: number;
    maxFramesPerSession?: number;
    maxTextCharsPerFrame?: number;
};

const DEFAULT_FLUSH_THRESHOLD = 10;
const DEFAULT_FLUSH_INTERVAL_MS = 1500;
const DEFAULT_MAX_SESSIONS = 10;
const DEFAULT_MAX_FRAMES_PER_SESSION = 150;
const DEFAULT_MAX_TEXT_CHARS_PER_FRAME = 900;

const FRAME_TRUNCATION_SUFFIX = '...<truncated>';

const createEmptyStore = (): StreamDumpStore => {
    const now = new Date().toISOString();
    return {
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        sessions: [],
    };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return !!value && typeof value === 'object' && !Array.isArray(value);
};

const asSession = (value: unknown): StreamDumpSession | null => {
    if (!isRecord(value)) {
        return null;
    }
    if (typeof value.attemptId !== 'string' || typeof value.platform !== 'string' || !Array.isArray(value.frames)) {
        return null;
    }
    return {
        attemptId: value.attemptId,
        platform: value.platform,
        conversationId: typeof value.conversationId === 'string' ? value.conversationId : null,
        startedAt: typeof value.startedAt === 'string' ? value.startedAt : new Date().toISOString(),
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
        frameCount: typeof value.frameCount === 'number' ? value.frameCount : value.frames.length,
        truncated: value.truncated === true,
        frames: value.frames.filter((item): item is StreamDumpFrame => {
            if (!isRecord(item)) {
                return false;
            }
            return (
                typeof item.timestamp === 'string' &&
                typeof item.platform === 'string' &&
                typeof item.attemptId === 'string' &&
                typeof item.kind === 'string' &&
                typeof item.text === 'string'
            );
        }),
    };
};

const normalizeStore = (raw: unknown): StreamDumpStore => {
    if (!isRecord(raw)) {
        return createEmptyStore();
    }
    const sessionsInput = Array.isArray(raw.sessions) ? raw.sessions : [];
    const sessions = sessionsInput.map((item) => asSession(item)).filter((item): item is StreamDumpSession => !!item);
    const now = new Date().toISOString();
    return {
        schemaVersion: 1,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
        sessions,
    };
};

const redactSensitiveTokens = (text: string): string => {
    return text
        .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, 'Bearer <redacted>')
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{8,}\.[A-Za-z0-9._-]{8,}\b/g, '<redacted:jwt>')
        .replace(/\b(authorization|cookie|token|api[_-]?key)\s*[:=]\s*[^\s"']+/gi, '$1=<redacted>');
};

const sanitizeFrameText = (text: string, maxChars: number): { text: string; truncated: boolean } => {
    const normalized = redactSensitiveTokens(text.replace(/\0/g, '')).trim();
    if (maxChars <= 0) {
        return { text: '', truncated: normalized.length > 0 };
    }
    if (normalized.length <= maxChars) {
        return { text: normalized, truncated: false };
    }
    if (maxChars <= FRAME_TRUNCATION_SUFFIX.length) {
        return {
            text: FRAME_TRUNCATION_SUFFIX.slice(0, maxChars),
            truncated: true,
        };
    }
    return {
        text: `${normalized.slice(0, maxChars - FRAME_TRUNCATION_SUFFIX.length)}${FRAME_TRUNCATION_SUFFIX}`,
        truncated: true,
    };
};

const asValidFrame = (input: StreamDumpFrameInput): StreamDumpFrameInput | null => {
    if (typeof input.platform !== 'string' || typeof input.attemptId !== 'string' || typeof input.text !== 'string') {
        return null;
    }
    if (input.platform.length === 0 || input.attemptId.length === 0) {
        return null;
    }
    if (input.text.trim().length === 0) {
        return null;
    }
    return input;
};

export class BufferedStreamDumpStorage {
    private readonly storage: StorageBackend;
    private readonly flushThreshold: number;
    private readonly flushIntervalMs: number;
    private readonly maxSessions: number;
    private readonly maxFramesPerSession: number;
    private readonly maxTextCharsPerFrame: number;
    private readonly storageKey: string;
    private buffer: StreamDumpFrameInput[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private isFlushing = false;

    constructor(storageBackend?: StorageBackend, options: StreamDumpOptions = {}) {
        this.storage = storageBackend || browser?.storage?.local || createInMemoryStorage();
        this.flushThreshold = options.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
        this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
        this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
        this.maxFramesPerSession = options.maxFramesPerSession ?? DEFAULT_MAX_FRAMES_PER_SESSION;
        this.maxTextCharsPerFrame = options.maxTextCharsPerFrame ?? DEFAULT_MAX_TEXT_CHARS_PER_FRAME;
        this.storageKey = STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_STORE;
    }

    public async saveFrame(input: StreamDumpFrameInput) {
        const frame = asValidFrame(input);
        if (!frame) {
            return;
        }
        this.buffer.push(frame);
        if (this.buffer.length >= this.flushThreshold) {
            await this.flush();
            return;
        }
        this.scheduleFlush();
    }

    public async getStore(): Promise<StreamDumpStore> {
        await this.flush();
        const result = await this.storage.get(this.storageKey);
        return normalizeStore(result[this.storageKey]);
    }

    public async clearStore() {
        this.buffer = [];
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        await this.storage.remove(this.storageKey);
    }

    private scheduleFlush() {
        if (this.flushTimer) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            void this.flush();
        }, this.flushIntervalMs);
    }

    private beginFlushBatch(): StreamDumpFrameInput[] | null {
        if (this.isFlushing || this.buffer.length === 0) {
            return null;
        }
        this.isFlushing = true;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        const batch = [...this.buffer];
        this.buffer = [];
        return batch;
    }

    private getSessionMap(store: StreamDumpStore): Map<string, StreamDumpSession> {
        const byAttempt = new Map<string, StreamDumpSession>();
        for (const session of store.sessions) {
            byAttempt.set(session.attemptId, session);
        }
        return byAttempt;
    }

    private getOrCreateSession(
        byAttempt: Map<string, StreamDumpSession>,
        input: StreamDumpFrameInput,
        nowIso: string,
    ): StreamDumpSession {
        let session = byAttempt.get(input.attemptId);
        if (session) {
            return session;
        }
        session = {
            attemptId: input.attemptId,
            platform: input.platform,
            conversationId: typeof input.conversationId === 'string' ? input.conversationId : null,
            startedAt: nowIso,
            updatedAt: nowIso,
            frameCount: 0,
            truncated: false,
            frames: [],
        };
        byAttempt.set(input.attemptId, session);
        return session;
    }

    private pushFrameToSession(session: StreamDumpSession, input: StreamDumpFrameInput, nowIso: string) {
        const { text, truncated } = sanitizeFrameText(input.text, this.maxTextCharsPerFrame);
        if (text.length === 0) {
            return;
        }
        if (!session.conversationId && typeof input.conversationId === 'string') {
            session.conversationId = input.conversationId;
        }
        session.updatedAt = nowIso;
        session.frameCount += 1;
        session.truncated = session.truncated || truncated;

        if (session.frames.length >= this.maxFramesPerSession) {
            session.frames.shift();
            session.truncated = true;
        }

        session.frames.push({
            timestamp: nowIso,
            platform: input.platform,
            attemptId: input.attemptId,
            conversationId: typeof input.conversationId === 'string' ? input.conversationId : null,
            kind: input.kind,
            text,
            ...(typeof input.chunkBytes === 'number' ? { chunkBytes: input.chunkBytes } : {}),
            ...(typeof input.frameIndex === 'number' ? { frameIndex: input.frameIndex } : {}),
        });
    }

    private mergeBatchIntoSessions(
        byAttempt: Map<string, StreamDumpSession>,
        batch: StreamDumpFrameInput[],
    ): Map<string, StreamDumpSession> {
        for (const input of batch) {
            const nowIso = new Date(input.timestampMs ?? Date.now()).toISOString();
            const session = this.getOrCreateSession(byAttempt, input, nowIso);
            this.pushFrameToSession(session, input, nowIso);
        }
        return byAttempt;
    }

    private finalizeSessions(byAttempt: Map<string, StreamDumpSession>): StreamDumpSession[] {
        const sessions = [...byAttempt.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const pruned = sessions.slice(0, this.maxSessions);
        const dropped = sessions.length - pruned.length;
        if (dropped > 0 && pruned.length > 0) {
            // Mark the oldest retained session to indicate older history was pruned.
            pruned[pruned.length - 1].truncated = true;
        }
        return pruned;
    }

    private restoreBatch(batch: StreamDumpFrameInput[]) {
        if (batch.length === 0) {
            return;
        }
        this.buffer = [...batch, ...this.buffer];
    }

    private async flush() {
        const batch = this.beginFlushBatch();
        if (!batch) {
            return;
        }

        try {
            const result = await this.storage.get(this.storageKey);
            const store = normalizeStore(result[this.storageKey]);
            const byAttempt = this.getSessionMap(store);
            this.mergeBatchIntoSessions(byAttempt, batch);
            const pruned = this.finalizeSessions(byAttempt);

            const nextStore: StreamDumpStore = {
                schemaVersion: 1,
                createdAt: store.createdAt,
                updatedAt: new Date().toISOString(),
                sessions: pruned,
            };

            await this.storage.set({ [this.storageKey]: nextStore });
        } catch {
            // Keep frames durable across transient quota/storage failures.
            this.restoreBatch(batch);
            this.scheduleFlush();
        } finally {
            this.isFlushing = false;
        }
    }
}

export const streamDumpStorage = new BufferedStreamDumpStorage();
