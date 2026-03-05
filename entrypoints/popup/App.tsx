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
import { getExportFormat } from '@/utils/runner/runtime/runtime-settings';
import {
    DEFAULT_BULK_EXPORT_DELAY_MS,
    DEFAULT_BULK_EXPORT_LIMIT,
    DEFAULT_BULK_EXPORT_TIMEOUT_MS,
    DEFAULT_EXPORT_FORMAT,
    EXPORT_FORMAT,
    type ExportFormat,
    STORAGE_KEYS,
} from '@/utils/settings';

const ABOUT_AUTHOR_NAME = 'Ragaeeb Haq';
const ABOUT_REPOSITORY_URL = 'https://github.com/ragaeeb/blackiya';

const App = () => {
    const manifest = browser.runtime.getManifest();
    const buildFilenameTag = getBuildFilenameTag();
    const [logLevel, setLogLevel] = useState<LogLevel>('info');
    const [logCount, setLogCount] = useState<number>(0);
    const [exportFormat, setExportFormat] = useState<ExportFormat>(DEFAULT_EXPORT_FORMAT);
    const [bulkExportLimitInput, setBulkExportLimitInput] = useState<string>(String(DEFAULT_BULK_EXPORT_LIMIT));
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
                ]);
                const level = result[STORAGE_KEYS.LOG_LEVEL] as LogLevel | undefined;
                if (level) {
                    setLogLevel(level);
                    logger.setLevel(level);
                }
                setBulkExportLimitInput(String(normalizeBulkExportLimitInput(result[STORAGE_KEYS.BULK_EXPORT_LIMIT])));
            } catch (error) {
                logger.warn('Failed to load popup settings from local storage', error);
            }

            try {
                await browser.storage.local.set({ [STORAGE_KEYS.STREAM_PROBE_VISIBLE]: false });
            } catch (error) {
                logger.warn('Failed to disable legacy stream probe visibility setting', error);
            }

            try {
                setExportFormat(await getExportFormat(DEFAULT_EXPORT_FORMAT));
            } catch (error) {
                logger.warn('Failed to resolve popup export format setting', error);
                setExportFormat(DEFAULT_EXPORT_FORMAT);
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

    const handleExportFormatChange: JSX.GenericEventHandler<HTMLSelectElement> = (e) => {
        const target = e.currentTarget as HTMLSelectElement | null;
        const newFormat = (target?.value || DEFAULT_EXPORT_FORMAT) as ExportFormat;
        const normalizedFormat = newFormat === EXPORT_FORMAT.COMMON ? EXPORT_FORMAT.COMMON : EXPORT_FORMAT.ORIGINAL;
        setExportFormat(normalizedFormat);
        browser.storage.local.set({ [STORAGE_KEYS.EXPORT_FORMAT]: normalizedFormat });
        logger.info(`Export format changed to ${normalizedFormat}`);
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
        setBulkExportLimitInput(String(options.limit));
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
            <div className="title">
                <img src="/icon/32.png" width="24" height="24" alt="Icon" />
                Blackiya Settings
            </div>

            <div className="section">
                <label htmlFor="logLevel">Log Level</label>
                <select id="logLevel" value={logLevel} onChange={handleLevelChange}>
                    <option value="debug">Debug</option>
                    <option value="info">Info</option>
                    <option value="warn">Warn</option>
                    <option value="error">Error</option>
                </select>
                <div style={{ fontSize: '12px', color: '#666' }}>Current Logs: {logCount} entries</div>
            </div>

            <div className="section">
                <label htmlFor="exportFormat">Export Format</label>
                <select id="exportFormat" value={exportFormat} onChange={handleExportFormatChange}>
                    <option value={EXPORT_FORMAT.ORIGINAL}>Original (Raw JSON)</option>
                    <option value={EXPORT_FORMAT.COMMON}>Common (Normalized)</option>
                </select>
                <div style={{ fontSize: '12px', color: '#666' }}>
                    Applies to Save actions in supported chat platforms.
                </div>
            </div>

            <div className="section">
                <div className="section-heading">Export Chats</div>
                <label htmlFor="bulkExportLimit">Max chats (0 = all)</label>
                <input
                    id="bulkExportLimit"
                    type="number"
                    min={0}
                    value={bulkExportLimitInput}
                    onChange={handleBulkExportLimitChange}
                />
                <button
                    type="button"
                    className="primary"
                    onClick={handleBulkExportChats}
                    disabled={bulkExportInProgress}
                >
                    {bulkExportInProgress ? 'Exporting Chats...' : 'Export Chats'}
                </button>
                {bulkExportStatus ? <div className="status-text">{bulkExportStatus}</div> : null}
            </div>

            <button type="button" className="primary" onClick={handleExport}>
                Export Full Logs (JSON)
            </button>

            <button type="button" className="primary" onClick={handleDebugExport}>
                Export Debug Report (TXT)
            </button>

            <button type="button" className="secondary" onClick={handleClear}>
                Clear Logs
            </button>

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
