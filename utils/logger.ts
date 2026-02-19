import { type ILogObj, Logger } from 'tslog';
import { browser } from 'wxt/browser';
import { type LogEntry, logsStorage } from './logs-storage';
import { STORAGE_KEYS } from './settings';

/**
 * Log levels supported by the extension
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Determine the current execution context
 */
const getContext = (): 'background' | 'content' | 'popup' => {
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
    // Content scripts run in a tab
    if (locationObj.protocol.startsWith('http')) {
        return 'content';
    }

    return 'background'; // Default to background if unsure
};

/**
 * Extension Logger
 *
 * A singleton logger instance that routes logs to both the console (for dev)
 * and persistent storage (for user export).
 */
class ExtensionLogger {
    private logger: Logger<ILogObj>;
    private static instance: ExtensionLogger;
    private context: 'background' | 'content' | 'popup';
    private storageListenerAttached = false;

    private constructor() {
        this.context = getContext();

        this.logger = new Logger({
            name: 'Blackiya',
            minLevel: 3, // Default to INFO
            hideLogPositionForProduction: true,
            type: 'json',
        });

        // Attach Transport for Persistence
        this.logger.attachTransport((logObj) => {
            this.handleTransport(logObj);
        });

        this.hydrateLogLevelFromStorage();
        this.attachStorageListener();
    }

    private handleTransport(logObj: ILogObj) {
        // Convert tslog level ID to string
        // 0: silly, 1: trace, 2: debug, 3: info, 4: warn, 5: error, 6: fatal
        const meta = (logObj as any)._meta;
        const levelId = meta ? meta.logLevelId : 3;

        const levelMap: Record<number, string> = { 2: 'debug', 3: 'info', 4: 'warn' };
        const level = levelId >= 5 ? 'error' : (levelMap[levelId] ?? 'info');

        // Construct standardized entry
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: level,
            message: logObj[0] as string, // tslog puts the first arg as message usually
            data: Object.keys(logObj)
                .filter((k) => !Number.isNaN(Number(k)) && k !== '0')
                .map((k) => logObj[k]), // Extract other args
            context: this.context,
        };

        // If in Background context, save directly
        if (this.context === 'background') {
            logsStorage.saveLog(entry).catch((err) => console.error('Logger failed to save:', err));
        } else {
            // In Content Script or Popup, assume we can send message
            // We use a try-catch because sending messages might fail during unload
            try {
                browser.runtime
                    .sendMessage({
                        type: 'LOG_ENTRY',
                        payload: entry,
                    })
                    .catch(() => {
                        // Ignore errors if background is unreachable (e.g. extension updating)
                    });
            } catch (_e) {
                // Squelch
            }
        }
    }

    public static getInstance(): ExtensionLogger {
        if (!ExtensionLogger.instance) {
            ExtensionLogger.instance = new ExtensionLogger();
        }
        return ExtensionLogger.instance;
    }

    public debug(message: string, ...args: unknown[]) {
        this.logger.debug(message, ...args);
    }

    public info(message: string, ...args: unknown[]) {
        this.logger.info(message, ...args);
    }

    public warn(message: string, ...args: unknown[]) {
        this.logger.warn(message, ...args);
    }

    public error(message: string, ...args: unknown[]) {
        this.logger.error(message, ...args);
    }

    public setLevel(level: LogLevel) {
        let minLevel = 3;
        switch (level) {
            case 'debug':
                minLevel = 2;
                break;
            case 'info':
                minLevel = 3;
                break;
            case 'warn':
                minLevel = 4;
                break;
            case 'error':
                minLevel = 5;
                break;
        }
        this.logger.settings.minLevel = minLevel;
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
            // Ignore; logger should continue with default level.
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
