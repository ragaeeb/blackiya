import { browser } from 'wxt/browser';

type StorageBackend = {
    get: (key: string) => Promise<Record<string, unknown>>;
    set: (value: Record<string, unknown>) => Promise<void>;
    remove: (key: string) => Promise<void>;
};

export type LogEntry = {
    timestamp: string;
    level: string;
    message: string;
    data?: any[];
    context: 'background' | 'content' | 'popup' | 'unknown';
};

export const MAX_LOGS = 4000;
const STORAGE_KEY = 'logs';
export const FLUSH_INTERVAL_MS = 2000;
export const FLUSH_THRESHOLD = 50;

const createInMemoryStorage = () => {
    const store = new Map<string, unknown>();

    return {
        async get(key: string) {
            return { [key]: store.get(key) };
        },
        async set(value: Record<string, unknown>) {
            for (const [key, entry] of Object.entries(value)) {
                store.set(key, entry);
            }
        },
        async remove(key: string) {
            store.delete(key);
        },
    };
};

export class BufferedLogsStorage {
    private buffer: LogEntry[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private isFlushing = false;
    private storage: StorageBackend;

    constructor(storageBackend?: StorageBackend) {
        this.storage = storageBackend || browser?.storage?.local || createInMemoryStorage();
    }

    /**
     * Append a log entry to the buffer.
     * Flushes immediately if threshold is reached.
     */
    async saveLog(entry: LogEntry) {
        this.buffer.push(entry);

        if (this.buffer.length >= FLUSH_THRESHOLD) {
            await this.flush();
        } else {
            this.scheduleFlush();
        }
    }

    /**
     * Retrieve all stored logs (flushes buffer first)
     */
    async getLogs(): Promise<LogEntry[]> {
        await this.flush();
        const result = await this.storage.get(STORAGE_KEY);
        return (result[STORAGE_KEY] as LogEntry[]) || [];
    }

    /**
     * Clear all logs
     */
    async clearLogs() {
        this.buffer = [];
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        await this.storage.remove(STORAGE_KEY);
    }

    private scheduleFlush() {
        if (this.flushTimer) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            this.flush();
        }, FLUSH_INTERVAL_MS);
    }

    private async flush() {
        if (this.isFlushing || this.buffer.length === 0) {
            return;
        }

        this.isFlushing = true;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        let batch: LogEntry[] = [];
        try {
            batch = [...this.buffer];
            this.buffer = [];

            const result = await this.storage.get(STORAGE_KEY);
            const currentLogs: LogEntry[] = (result[STORAGE_KEY] as LogEntry[]) || [];

            const mergedLogs = currentLogs.concat(batch);

            // Rotate if too large
            if (mergedLogs.length > MAX_LOGS) {
                mergedLogs.splice(0, mergedLogs.length - MAX_LOGS);
            }

            await this.storage.set({ [STORAGE_KEY]: mergedLogs });
        } catch (e) {
            console.error('Failed to flush logs to storage', e);
            // Restore failed batch ahead of newly buffered entries.
            this.buffer = [...batch, ...this.buffer];
            if (this.buffer.length > MAX_LOGS) {
                this.buffer = this.buffer.slice(this.buffer.length - MAX_LOGS);
            }
        } finally {
            this.isFlushing = false;
        }
    }
}

export const logsStorage = new BufferedLogsStorage();
