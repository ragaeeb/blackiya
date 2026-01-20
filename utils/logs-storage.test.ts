import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock wxt/browser at the very top to handle side-effects in logs-storage.ts
mock.module('wxt/browser', () => ({
    browser: {
        storage: {
            local: {
                get: async () => ({}),
                set: async () => {},
                remove: async () => {},
            },
        },
    },
}));

describe('BufferedLogsStorage', () => {
    let BufferedLogsStorage: any;
    let FLUSH_INTERVAL_MS: number;
    let FLUSH_THRESHOLD: number;
    let MAX_LOGS: number;

    let storedLogs: any[] = [];
    let storage: any;
    let setSpy: any;
    let getSpy: any;
    let removeSpy: any;

    beforeAll(async () => {
        const mod = await import('./logs-storage');
        BufferedLogsStorage = mod.BufferedLogsStorage;
        FLUSH_INTERVAL_MS = mod.FLUSH_INTERVAL_MS;
        FLUSH_THRESHOLD = mod.FLUSH_THRESHOLD;
        MAX_LOGS = mod.MAX_LOGS;
    });

    beforeEach(() => {
        storedLogs = [];

        // Define isolated spies that only affect THIS test suite's backend
        setSpy = mock(async (data: any) => {
            if (data.logs) {
                storedLogs = data.logs;
            }
        });

        getSpy = mock(async () => {
            return { logs: [...storedLogs] };
        });

        removeSpy = mock(async () => {
            storedLogs = [];
        });

        // Create explicit mock backend
        const mockBackend = {
            get: getSpy,
            set: setSpy,
            remove: removeSpy,
        };

        // Use a fresh instance for each test with isolated backend!
        storage = new BufferedLogsStorage(mockBackend);
    });

    afterEach(() => {
        // cleanup timers
        if (storage) {
            storage.clearLogs();
        }
    });

    it('should buffer logs and not write immediately', async () => {
        const entry = {
            timestamp: 'test',
            level: 'info',
            message: 'test message',
            context: 'background',
        };

        await storage.saveLog(entry);

        expect(setSpy).not.toHaveBeenCalled();
    });

    it('should flush when threshold is reached', async () => {
        const entry = {
            timestamp: 'test',
            level: 'info',
            message: 'test message',
            context: 'background',
        };

        // Fill buffer up to threshold - 1
        for (let i = 0; i < FLUSH_THRESHOLD - 1; i++) {
            await storage.saveLog({ ...entry, message: `msg ${i}` });
        }
        expect(setSpy).not.toHaveBeenCalled();

        // Trigger flush
        await storage.saveLog({ ...entry, message: 'last msg' });

        expect(setSpy).toHaveBeenCalledTimes(1);
        expect(storedLogs.length).toBe(FLUSH_THRESHOLD);
    });

    it('should flush after timeout', async () => {
        const entry = {
            timestamp: 'test',
            level: 'info',
            message: 'test message',
            context: 'background',
        };

        await storage.saveLog(entry);
        expect(setSpy).not.toHaveBeenCalled();

        // Wait specifically for flush interval + buffer
        await new Promise((resolve) => setTimeout(resolve, FLUSH_INTERVAL_MS + 200));

        expect(setSpy).toHaveBeenCalled();
        expect(storedLogs.length).toBe(1);
    });

    it('should rotate logs when limit exceeded', async () => {
        // Simulate existing logs in storage
        const existingLogs = Array(MAX_LOGS).fill({
            timestamp: 'old',
            level: 'info',
            message: 'old message',
            context: 'background',
        });
        storedLogs = [...existingLogs];

        // Add one new log
        await storage.saveLog({
            timestamp: 'new',
            level: 'info',
            message: 'new message',
            context: 'background',
        });

        // Trigger generic flush by saving enough or waiting?
        // Or call getLogs() which flushes.
        await storage.getLogs();

        expect(setSpy).toHaveBeenCalled();

        // Check stored logs
        expect(storedLogs.length).toBe(MAX_LOGS);
        // The last log should be the new one
        expect(storedLogs[storedLogs.length - 1].message).toBe('new message');
    });

    it('should clear logs and buffer', async () => {
        await storage.saveLog({
            timestamp: 'test',
            level: 'info',
            message: 'buffered',
            context: 'background',
        });

        await storage.clearLogs();

        expect(removeSpy).toHaveBeenCalled();
        expect(storedLogs.length).toBe(0);

        // Verify buffer is also cleared by checking if getLogs returns empty
        const logs = await storage.getLogs();
        expect(logs.length).toBe(0);
    });
});
