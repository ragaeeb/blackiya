import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { normalizeBulkExportLimitInput } from '@/entrypoints/popup/bulk-export-input';
import { getBuildFilenameTag } from '@/utils/build-fingerprint';
import { downloadAsJSON } from '@/utils/download';
import { type LogLevel, logger } from '@/utils/logger';
import { logsStorage } from '@/utils/logs-storage';
import { downloadMinimalDebugReport } from '@/utils/minimal-logs';
import { BULK_EXPORT_CHATS_MESSAGE, type BulkExportChatsResponse } from '@/utils/runner/bulk-chat-export-contract';
import {
    DEFAULT_BULK_EXPORT_DELAY_MS,
    DEFAULT_BULK_EXPORT_LIMIT,
    DEFAULT_BULK_EXPORT_TIMEOUT_MS,
    DEFAULT_EXTENSION_ENABLED,
    STORAGE_KEYS,
} from '@/utils/settings';

const ABOUT_AUTHOR_NAME = 'Ragaeeb Haq';
const ABOUT_REPOSITORY_URL = 'https://github.com/ragaeeb/blackiya';

const App = () => {
    const manifest = browser.runtime.getManifest();
    const buildFilenameTag = getBuildFilenameTag();
    const [extensionEnabled, setExtensionEnabled] = useState<boolean>(DEFAULT_EXTENSION_ENABLED);
    const [logLevel, setLogLevel] = useState<LogLevel>('info');
    const [logCount, setLogCount] = useState<number>(0);
    const [bulkExportLimitInput, setBulkExportLimitInput] = useState<string>('');
    const [bulkExportInProgress, setBulkExportInProgress] = useState<boolean>(false);
    const [bulkExportStatus, setBulkExportStatus] = useState<string>('');

    const getActiveTabId = async (): Promise<number | null> => {
        try {
            const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
            return typeof activeTab?.id === 'number' ? activeTab.id : null;
        } catch {
            return null;
        }
    };

    const resolveBulkExportOptions = () => {
        const normalizedLimit = normalizeBulkExportLimitInput(bulkExportLimitInput);
        return {
            limit: normalizedLimit,
            delayMs: DEFAULT_BULK_EXPORT_DELAY_MS,
            timeoutMs: DEFAULT_BULK_EXPORT_TIMEOUT_MS,
        };
    };

    useEffect(() => {
        const loadSettings = async () => {
            try {
                const result = await browser.storage.local.get([
                    STORAGE_KEYS.LOG_LEVEL,
                    STORAGE_KEYS.BULK_EXPORT_LIMIT,
                    STORAGE_KEYS.EXTENSION_ENABLED,
                ]);
                const level = result[STORAGE_KEYS.LOG_LEVEL] as LogLevel | undefined;
                if (level) {
                    setLogLevel(level);
                    logger.setLevel(level);
                }
                setExtensionEnabled(result[STORAGE_KEYS.EXTENSION_ENABLED] !== false);
                const normalizedLimit = normalizeBulkExportLimitInput(result[STORAGE_KEYS.BULK_EXPORT_LIMIT]);
                setBulkExportLimitInput(normalizedLimit === DEFAULT_BULK_EXPORT_LIMIT ? '' : String(normalizedLimit));
            } catch (error) {
                logger.warn('Failed to load popup settings from local storage', error);
            }

            try {
                await browser.storage.local.set({ [STORAGE_KEYS.STREAM_PROBE_VISIBLE]: false });
            } catch (error) {
                logger.warn('Failed to disable legacy stream probe visibility setting', error);
            }
        };
        void loadSettings();

        // Load log stats
        logsStorage.getLogs().then((logs) => {
            setLogCount(logs.length);
        });
    }, []);

    const handleLevelChange: JSX.GenericEventHandler<HTMLSelectElement> = (e) => {
        const target = e.currentTarget as HTMLSelectElement | null;
        const newLevel = (target?.value || 'info') as LogLevel;
        setLogLevel(newLevel);
        browser.storage.local.set({ [STORAGE_KEYS.LOG_LEVEL]: newLevel });
        logger.setLevel(newLevel);
        logger.info(`Log level changed to ${newLevel}`);
    };

    const handleExtensionEnabledChange: JSX.GenericEventHandler<HTMLInputElement> = (e) => {
        const target = e.currentTarget as HTMLInputElement | null;
        const enabled = target?.checked !== false;
        setExtensionEnabled(enabled);
        void browser.storage.local.set({ [STORAGE_KEYS.EXTENSION_ENABLED]: enabled });
    };

    const handleBulkExportLimitChange: JSX.GenericEventHandler<HTMLInputElement> = (e) => {
        const target = e.currentTarget as HTMLInputElement | null;
        const nextValue = target?.value ?? '';
        setBulkExportLimitInput(nextValue);
        const normalized = normalizeBulkExportLimitInput(nextValue);
        void browser.storage.local.set({ [STORAGE_KEYS.BULK_EXPORT_LIMIT]: normalized });
    };

    const persistBulkExportSettings = async (options: { limit: number }) => {
        await browser.storage.local.set({
            [STORAGE_KEYS.BULK_EXPORT_LIMIT]: options.limit,
        });
    };

    const requestBulkExportFromActiveTab = async (
        tabId: number,
        options: { limit: number; delayMs: number; timeoutMs: number },
    ) => {
        const response = (await browser.tabs.sendMessage(tabId, {
            type: BULK_EXPORT_CHATS_MESSAGE,
            limit: options.limit,
            delayMs: options.delayMs,
            timeoutMs: options.timeoutMs,
        })) as BulkExportChatsResponse | undefined;

        if (!response) {
            throw new Error('No response from content script.');
        }
        if (!response.ok) {
            throw new Error(response.error || 'Bulk export failed.');
        }
        return response.result;
    };

    const formatBulkExportStatus = (result: {
        exported: number;
        attempted: number;
        platform: string;
        warnings: string[];
    }) => {
        const warningText = result.warnings.length > 0 ? ` Warnings: ${result.warnings.join(' | ')}` : '';
        return `Exported ${result.exported}/${result.attempted} chats on ${result.platform}.${warningText}`;
    };

    const handleBulkExportChats = async () => {
        if (bulkExportInProgress) {
            return;
        }
        const tabId = await getActiveTabId();
        if (tabId === null) {
            alert('No active tab found.');
            return;
        }

        const options = resolveBulkExportOptions();
        setBulkExportLimitInput(options.limit === DEFAULT_BULK_EXPORT_LIMIT ? '' : String(options.limit));
        await persistBulkExportSettings(options);

        setBulkExportInProgress(true);
        setBulkExportStatus('Export in progress...');

        try {
            const result = await requestBulkExportFromActiveTab(tabId, options);
            setBulkExportStatus(formatBulkExportStatus(result));
            logger.info('Bulk chat export finished', result);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setBulkExportStatus(`Bulk export failed: ${message}`);
            logger.warn('Bulk chat export failed from popup', { error: message });
            alert(`Bulk export failed: ${message}`);
        } finally {
            setBulkExportInProgress(false);
        }
    };

    const handleExport = async () => {
        try {
            const logs = await logsStorage.getLogs();
            if (logs.length === 0) {
                alert('No logs to export.');
                return;
            }

            const timestamp = new Date().toISOString().replace(/[:]/g, '-');
            const filename = `blackiya-logs-${buildFilenameTag}-${timestamp}`;
            downloadAsJSON(logs, filename);

            logger.info('Logs exported by user');
        } catch (error) {
            console.error('Failed to export logs', error);
            logger.error('Failed to export logs', error);
        }
    };

    const handleDebugExport = async () => {
        try {
            const logs = await logsStorage.getLogs();
            if (logs.length === 0) {
                alert('No logs to export.');
                return;
            }

            const timestamp = new Date().toISOString().replace(/[:]/g, '-');
            downloadMinimalDebugReport(logs, `blackiya-debug-${buildFilenameTag}-${timestamp}`);
            logger.info('Debug report exported by user');
        } catch (error) {
            console.error('Failed to export debug report', error);
            logger.error('Failed to export debug report', error);
        }
    };

    const handleClear = async () => {
        if (confirm('Are you sure you want to clear all logs?')) {
            await logsStorage.clearLogs();
            setLogCount(0);
            logger.info('Logs cleared by user');
        }
    };

    return (
        <div>
            <div className="title-row">
                <div className="title">
                    <img src="/icon/32.png" width="24" height="24" alt="Icon" />
                    Blackiya Settings
                </div>
                <label className="header-toggle" htmlFor="extensionEnabled" aria-label="Toggle Blackiya extension">
                    <span className="toggle-switch compact">
                        <input
                            id="extensionEnabled"
                            type="checkbox"
                            checked={extensionEnabled}
                            onChange={handleExtensionEnabledChange}
                        />
                        <span className="toggle-slider" aria-hidden="true" />
                    </span>
                </label>
            </div>

            <div className="section">
                <div className="section-heading">Export Chats</div>
                <div className="split-row">
                    <button
                        type="button"
                        className="primary split-row-button"
                        onClick={handleBulkExportChats}
                        disabled={bulkExportInProgress}
                    >
                        {bulkExportInProgress ? 'Exporting Chats...' : 'Export Chats'}
                    </button>
                    <input
                        id="bulkExportLimit"
                        type="number"
                        min={0}
                        value={bulkExportLimitInput}
                        onChange={handleBulkExportLimitChange}
                        placeholder="Max chats (0 = all)"
                    />
                </div>
                {bulkExportStatus ? <div className="status-text">{bulkExportStatus}</div> : null}
            </div>

            <div className="section">
                <div className="section-heading">Logs</div>
                <label htmlFor="logLevel">Log Level</label>
                <select id="logLevel" value={logLevel} onChange={handleLevelChange}>
                    <option value="debug">Debug</option>
                    <option value="info">Info</option>
                    <option value="warn">Warn</option>
                    <option value="error">Error</option>
                </select>
                <div className="section-meta">Current Logs: {logCount} entries</div>
                <div className="button-row compact-button-row">
                    <button type="button" className="primary compact-button" onClick={handleExport}>
                        Full
                    </button>
                    <button type="button" className="primary compact-button" onClick={handleDebugExport}>
                        Debug
                    </button>
                    <button type="button" className="secondary compact-button" onClick={handleClear}>
                        Clear
                    </button>
                </div>
            </div>

            <div className="about">
                <p>Blackiya v{manifest.version}</p>
                <p>
                    By{' '}
                    <a href="https://github.com/ragaeeb" target="_blank" rel="noreferrer">
                        {ABOUT_AUTHOR_NAME}
                    </a>
                </p>
                <p>
                    <a href={ABOUT_REPOSITORY_URL} target="_blank" rel="noreferrer">
                        GitHub Repository
                    </a>
                </p>
            </div>
        </div>
    );
};

export default App;
