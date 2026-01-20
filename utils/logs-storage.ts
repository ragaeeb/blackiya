import { browser } from 'wxt/browser';

export interface LogEntry {
    timestamp: string;
    level: string;
    message: string;
    data?: any[];
    context: 'background' | 'content' | 'popup' | 'unknown';
}

const MAX_LOGS = 1000;
const STORAGE_KEY = 'logs';
const FLUSH_INTERVAL_MS = 2000;
const FLUSH_THRESHOLD = 50;

export class BufferedLogsStorage {
    private buffer: LogEntry[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private isFlushing = false;
    private storage: any;

    constructor(storageBackend?: any) {
        this.storage = storageBackend || browser.storage.local;
    }

    /**
     * Append a log entry to the buffer.
     * Flushes immediately if threshold is reached.
     */
    async saveLog(entry: LogEntry): Promise<void> {
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
    async clearLogs(): Promise<void> {
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

        try {
            const batch = [...this.buffer];
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
            // Put batch back in buffer? Simple retry strategy for now is just basic error logging
        } finally {
            this.isFlushing = false;
        }
    }
}

export const logsStorage = new BufferedLogsStorage();
