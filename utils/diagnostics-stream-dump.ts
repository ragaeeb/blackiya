import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/utils/settings';

interface StorageBackend {
    get: (key: string) => Promise<Record<string, unknown>>;
    set: (value: Record<string, unknown>) => Promise<void>;
    remove: (key: string) => Promise<void>;
}

function createInMemoryStorage(): StorageBackend {
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
}

export type StreamDumpFrameKind = 'snapshot' | 'heuristic' | 'delta' | 'lifecycle';

export interface StreamDumpFrameInput {
    platform: string;
    attemptId: string;
    conversationId?: string | null;
    kind: StreamDumpFrameKind;
    text: string;
    chunkBytes?: number;
    frameIndex?: number;
    timestampMs?: number;
}

export interface StreamDumpFrame {
    timestamp: string;
    platform: string;
    attemptId: string;
    conversationId: string | null;
    kind: StreamDumpFrameKind;
    text: string;
    chunkBytes?: number;
    frameIndex?: number;
}

export interface StreamDumpSession {
    attemptId: string;
    platform: string;
    conversationId: string | null;
    startedAt: string;
    updatedAt: string;
    frameCount: number;
    truncated: boolean;
    frames: StreamDumpFrame[];
}

export interface StreamDumpStore {
    schemaVersion: 1;
    createdAt: string;
    updatedAt: string;
    sessions: StreamDumpSession[];
}

interface StreamDumpOptions {
    flushThreshold?: number;
    flushIntervalMs?: number;
    maxSessions?: number;
    maxFramesPerSession?: number;
    maxTextCharsPerFrame?: number;
}

const DEFAULT_FLUSH_THRESHOLD = 10;
const DEFAULT_FLUSH_INTERVAL_MS = 1500;
const DEFAULT_MAX_SESSIONS = 25;
const DEFAULT_MAX_FRAMES_PER_SESSION = 240;
const DEFAULT_MAX_TEXT_CHARS_PER_FRAME = 1200;

function createEmptyStore(): StreamDumpStore {
    const now = new Date().toISOString();
    return {
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        sessions: [],
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asSession(value: unknown): StreamDumpSession | null {
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
}

function normalizeStore(raw: unknown): StreamDumpStore {
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
}

function redactSensitiveTokens(text: string): string {
    return text
        .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, 'Bearer <redacted>')
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{8,}\.[A-Za-z0-9._-]{8,}\b/g, '<redacted:jwt>')
        .replace(/\b(authorization|cookie|token|api[_-]?key)\s*[:=]\s*[^\s"']+/gi, '$1=<redacted>');
}

function sanitizeFrameText(text: string, maxChars: number): { text: string; truncated: boolean } {
    const normalized = redactSensitiveTokens(text.replace(/\0/g, '')).trim();
    if (normalized.length <= maxChars) {
        return { text: normalized, truncated: false };
    }
    return {
        text: `${normalized.slice(0, Math.max(0, maxChars - 13))}...<truncated>`,
        truncated: true,
    };
}

function asValidFrame(input: StreamDumpFrameInput): StreamDumpFrameInput | null {
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
}

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

    public async saveFrame(input: StreamDumpFrameInput): Promise<void> {
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

    public async clearStore(): Promise<void> {
        this.buffer = [];
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        await this.storage.remove(this.storageKey);
    }

    private scheduleFlush(): void {
        if (this.flushTimer) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            void this.flush();
        }, this.flushIntervalMs);
    }

    private async flush(): Promise<void> {
        if (this.isFlushing || this.buffer.length === 0) {
            return;
        }

        this.isFlushing = true;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        try {
            const batch = [...this.buffer];
            this.buffer = [];

            const result = await this.storage.get(this.storageKey);
            const store = normalizeStore(result[this.storageKey]);
            const byAttempt = new Map<string, StreamDumpSession>();
            for (const session of store.sessions) {
                byAttempt.set(session.attemptId, session);
            }

            for (const input of batch) {
                const nowIso = new Date(input.timestampMs ?? Date.now()).toISOString();
                const { text, truncated } = sanitizeFrameText(input.text, this.maxTextCharsPerFrame);
                if (text.length === 0) {
                    continue;
                }

                let session = byAttempt.get(input.attemptId);
                if (!session) {
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

            const sessions = [...byAttempt.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            const pruned = sessions.slice(0, this.maxSessions);
            const dropped = sessions.length - pruned.length;
            if (dropped > 0) {
                // Keep a small signal that trimming occurred by marking newest session as truncated.
                pruned[0].truncated = true;
            }

            const nextStore: StreamDumpStore = {
                schemaVersion: 1,
                createdAt: store.createdAt,
                updatedAt: new Date().toISOString(),
                sessions: pruned,
            };

            await this.storage.set({ [this.storageKey]: nextStore });
        } finally {
            this.isFlushing = false;
        }
    }
}

export const streamDumpStorage = new BufferedStreamDumpStorage();
