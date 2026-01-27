import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { downloadAsJSON } from '@/utils/download';
import { type LogLevel, logger } from '@/utils/logger';
import { logsStorage } from '@/utils/logs-storage';
import packageJson from '../../package.json';

const STORAGE_KEY_LEVEL = 'userSettings.logLevel';

function App() {
    const [logLevel, setLogLevel] = useState<LogLevel>('info');
    const [logCount, setLogCount] = useState<number>(0);

    useEffect(() => {
        // Load settings
        browser.storage.local.get(STORAGE_KEY_LEVEL).then((result) => {
            const level = result[STORAGE_KEY_LEVEL] as LogLevel | undefined;
            if (level) {
                setLogLevel(level);
                logger.setLevel(level);
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
        browser.storage.local.set({ [STORAGE_KEY_LEVEL]: newLevel });
        logger.setLevel(newLevel);
        logger.info(`Log level changed to ${newLevel}`);
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

            <button type="button" className="primary" onClick={handleExport}>
                Export Debug Logs
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
