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

export const logsStorage = {
    /**
     * Append a log entry to storage.
     * Implements a rolling buffer to prevent exceeding storage limits.
     */
    async saveLog(entry: LogEntry): Promise<void> {
        try {
            // We use raw browser.storage.local
            // For a high-frequency logger, reading the whole array, appending, and writing back is slow.
            // But sufficient for this use case.

            const result = await browser.storage.local.get(STORAGE_KEY);
            const logs: LogEntry[] = (result[STORAGE_KEY] as LogEntry[]) || [];

            logs.push(entry);

            // Rotate if too large
            if (logs.length > MAX_LOGS) {
                logs.splice(0, logs.length - MAX_LOGS);
            }

            await browser.storage.local.set({ [STORAGE_KEY]: logs });
        } catch (e) {
            console.error('Failed to save log', e);
        }
    },

    /**
     * Retrieve all stored logs
     */
    async getLogs(): Promise<LogEntry[]> {
        const result = await browser.storage.local.get(STORAGE_KEY);
        return (result[STORAGE_KEY] as LogEntry[]) || [];
    },

    /**
     * Clear all logs
     */
    async clearLogs(): Promise<void> {
        await browser.storage.local.remove(STORAGE_KEY);
    },
};
