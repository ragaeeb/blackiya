import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { downloadAsJSON } from '@/utils/download';
import { type LogLevel, logger } from '@/utils/logger';
import { logsStorage } from '@/utils/logs-storage';
import { downloadMinimalDebugReport } from '@/utils/minimal-logs';
import { DEFAULT_EXPORT_FORMAT, type ExportFormat, STORAGE_KEYS } from '@/utils/settings';
import packageJson from '../../package.json';

function App() {
    const [logLevel, setLogLevel] = useState<LogLevel>('info');
    const [logCount, setLogCount] = useState<number>(0);
    const [exportFormat, setExportFormat] = useState<ExportFormat>(DEFAULT_EXPORT_FORMAT);

    useEffect(() => {
        // Load settings
        browser.storage.local.get([STORAGE_KEYS.LOG_LEVEL, STORAGE_KEYS.EXPORT_FORMAT]).then((result) => {
            const level = result[STORAGE_KEYS.LOG_LEVEL] as LogLevel | undefined;
            if (level) {
                setLogLevel(level);
                logger.setLevel(level);
            }

            const savedFormat = result[STORAGE_KEYS.EXPORT_FORMAT] as ExportFormat | undefined;
            if (savedFormat === 'common' || savedFormat === 'original') {
                setExportFormat(savedFormat);
            }
        });

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
        const normalizedFormat = newFormat === 'common' ? 'common' : 'original';
        setExportFormat(normalizedFormat);
        browser.storage.local.set({ [STORAGE_KEYS.EXPORT_FORMAT]: normalizedFormat });
        logger.info(`Export format changed to ${normalizedFormat}`);
    };

    const handleExport = async () => {
        try {
            const logs = await logsStorage.getLogs();
            if (logs.length === 0) {
                alert('No logs to export.');
                return;
            }

            const timestamp = new Date().toISOString().replace(/[:]/g, '-');
            const filename = `blackiya-logs-${timestamp}`;
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

            downloadMinimalDebugReport(logs);
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
                <img src="/icon.svg" width="24" height="24" alt="Icon" />
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
                    <option value="original">Original (Raw JSON)</option>
                    <option value="common">Common (Normalized)</option>
                </select>
                <div style={{ fontSize: '12px', color: '#666' }}>
                    Applies to Save JSON and Copy actions in supported chat platforms.
                </div>
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
                <p>Blackiya v{packageJson.version}</p>
                <p>
                    By{' '}
                    <a href="https://github.com/ragaeeb" target="_blank" rel="noreferrer">
                        {packageJson.author}
                    </a>
                </p>
                <p>
                    <a href={packageJson.repository.url.replace('git+', '')} target="_blank" rel="noreferrer">
                        GitHub Repository
                    </a>
                </p>
            </div>
        </div>
    );
}

export default App;
