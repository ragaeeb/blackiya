import { browser } from 'wxt/browser';
import { type LogEntry, logsStorage } from './logs-storage';
import { STORAGE_KEYS } from './settings';

/**
 * Log levels supported by the extension
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogContext = 'background' | 'content' | 'popup' | 'unknown';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 2,
    info: 3,
    warn: 4,
    error: 5,
};

/**
 * Determine the current execution context.
 */
const getContext = (): LogContext => {
    if (typeof window === 'undefined') {
        return 'background';
    }

    const locationObj = typeof location !== 'undefined' ? location : null;
    if (!locationObj) {
        return 'background';
    }

    if (locationObj.protocol === 'chrome-extension:' && locationObj.pathname.includes('popup')) {
        return 'popup';
    }
    if (locationObj.protocol.startsWith('http')) {
        return 'content';
    }

    return 'unknown';
};

class ExtensionLogger {
    private static instance: ExtensionLogger;
    private context: LogContext;
    private minLevel = LOG_LEVEL_PRIORITY.info;
    private storageListenerAttached = false;

    private constructor() {
        this.context = getContext();
        this.hydrateLogLevelFromStorage();
        this.attachStorageListener();
    }

    private sanitizePrimitiveValue(value: unknown): { handled: true; value: unknown } | { handled: false } {
        if (value === null || value === undefined) {
            return { handled: true, value: value ?? null };
        }
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return { handled: true, value };
        }
        if (typeof value === 'bigint') {
            return { handled: true, value: `${value}n` };
        }
        if (typeof value === 'symbol') {
            return { handled: true, value: value.toString() };
        }
        if (typeof value === 'function') {
            return { handled: true, value: `[Function ${value.name || 'anonymous'}]` };
        }
        return { handled: false };
    }

    private sanitizeSpecialObject(value: unknown): { handled: true; value: unknown } | { handled: false } {
        if (value instanceof Date) {
            return { handled: true, value: value.toISOString() };
        }
        if (value instanceof Error) {
            return {
                handled: true,
                value: {
                    name: value.name,
                    message: value.message,
                    stack: value.stack ?? null,
                },
            };
        }
        if (typeof Node !== 'undefined' && value instanceof Node) {
            return { handled: true, value: `[Node ${value.nodeName}]` };
        }
        return { handled: false };
    }

    private sanitizeRecord(value: Record<string, unknown>, seen: WeakSet<object>): Record<string, unknown> {
        const result: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            result[key] = this.sanitizeLogValue(entry, seen);
        }
        return result;
    }

    private sanitizeLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
        const primitive = this.sanitizePrimitiveValue(value);
        if (primitive.handled) {
            return primitive.value;
        }

        const specialObject = this.sanitizeSpecialObject(value);
        if (specialObject.handled) {
            return specialObject.value;
        }

        if (!value || typeof value !== 'object') {
            return String(value);
        }
        if (seen.has(value)) {
            return '[Circular]';
        }
        seen.add(value);

        if (Array.isArray(value)) {
            return value.map((entry) => this.sanitizeLogValue(entry, seen));
        }

        return this.sanitizeRecord(value as Record<string, unknown>, seen);
    }

    private emit(level: LogLevel, message: string, args: unknown[]) {
        if (LOG_LEVEL_PRIORITY[level] < this.minLevel) {
            return;
        }

        const sanitizedArgs = args.map((arg) => this.sanitizeLogValue(arg));

        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            data: sanitizedArgs,
            context: this.context,
        };

        this.emitToConsole(level, message, args);
        this.persistEntry(entry);
    }

    private emitToConsole(level: LogLevel, message: string, args: unknown[]) {
        const prefix = '[Blackiya]';
        if (level === 'debug') {
            console.debug(prefix, message, ...args);
            return;
        }
        if (level === 'info') {
            console.info(prefix, message, ...args);
            return;
        }
        if (level === 'warn') {
            console.warn(prefix, message, ...args);
            return;
        }
        console.error(prefix, message, ...args);
    }

    private persistEntry(entry: LogEntry) {
        if (this.context === 'background') {
            logsStorage.saveLog(entry).catch((err) => console.error('Logger failed to save:', err));
            return;
        }

        try {
            browser.runtime
                .sendMessage({
                    type: 'LOG_ENTRY',
                    payload: entry,
                })
                .catch((error) => {
                    logsStorage.saveLog(entry).catch((persistError) => {
                        console.error('Logger failed to save after runtime send error:', error, persistError);
                    });
                });
        } catch (error) {
            logsStorage.saveLog(entry).catch((persistError) => {
                console.error('Logger failed to save after runtime throw:', error, persistError);
            });
        }
    }

    public static getInstance(): ExtensionLogger {
        if (!ExtensionLogger.instance) {
            ExtensionLogger.instance = new ExtensionLogger();
        }
        return ExtensionLogger.instance;
    }

    public debug(message: string, ...args: unknown[]) {
        this.emit('debug', message, args);
    }

    public info(message: string, ...args: unknown[]) {
        this.emit('info', message, args);
    }

    public warn(message: string, ...args: unknown[]) {
        this.emit('warn', message, args);
    }

    public error(message: string, ...args: unknown[]) {
        this.emit('error', message, args);
    }

    public setLevel(level: LogLevel) {
        this.minLevel = LOG_LEVEL_PRIORITY[level];
    }

    private async hydrateLogLevelFromStorage() {
        if (!browser?.storage?.local?.get) {
            return;
        }
        try {
            const result = await browser.storage.local.get(STORAGE_KEYS.LOG_LEVEL);
            const storedLevel = result[STORAGE_KEYS.LOG_LEVEL];
            if (
                storedLevel === 'debug' ||
                storedLevel === 'info' ||
                storedLevel === 'warn' ||
                storedLevel === 'error'
            ) {
                this.setLevel(storedLevel);
            }
        } catch {
            // Ignore storage failures and keep default level.
        }
    }

    private attachStorageListener() {
        if (this.storageListenerAttached) {
            return;
        }
        if (!browser?.storage?.onChanged?.addListener) {
            return;
        }
        this.storageListenerAttached = true;

        browser.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local') {
                return;
            }
            const changedLevel = changes[STORAGE_KEYS.LOG_LEVEL]?.newValue;
            if (
                changedLevel === 'debug' ||
                changedLevel === 'info' ||
                changedLevel === 'warn' ||
                changedLevel === 'error'
            ) {
                this.setLevel(changedLevel);
            }
        });
    }
}

export const logger = ExtensionLogger.getInstance();
