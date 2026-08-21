import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { normalizeBulkExportLimitInput } from '@/entrypoints/popup/bulk-export-input';
import { downloadAsJSON, generateTimestamp } from '@/utils/download';
import { DEFAULT_BULK_EXPORT_LIMIT, STORAGE_KEYS } from '@/utils/settings';
import {
    createClearStreamDebugMessage,
    createExportChatsMessage,
    createExportStreamDebugMessage,
    formatBulkExportStatus,
    formatStreamDebugClearedStatus,
    formatStreamDebugExportedStatus,
    isV3ErrorResponse,
    isV3SuccessResponse,
    type V3Message,
} from './v3-messaging';

const ABOUT_AUTHOR_NAME = 'Ragaeeb Haq';
const ABOUT_REPOSITORY_URL = 'https://github.com/ragaeeb/blackiya';

type BusyAction = 'export-chats' | 'export-stream-debug' | 'clear-stream-debug' | null;

type StatusState = {
    kind: 'info' | 'error';
    text: string;
};

const getActiveTabId = async (): Promise<number | null> => {
    try {
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        return typeof activeTab?.id === 'number' ? activeTab.id : null;
    } catch {
        return null;
    }
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sendToActiveTab = async (message: V3Message): Promise<unknown> => {
    const tabId = await getActiveTabId();
    if (tabId === null) {
        throw new Error('No active tab found.');
    }

    let response: unknown;
    try {
        response = await browser.tabs.sendMessage(tabId, message);
    } catch (error) {
        throw new Error(`Could not reach the page. Open a supported chat and retry. (${errorMessage(error)})`);
    }

    if (!response) {
        throw new Error('No response from the page. Open a supported chat and retry.');
    }
    if (isV3ErrorResponse(response)) {
        throw new Error(response.error);
    }
    if (!isV3SuccessResponse(response)) {
        throw new Error('Unexpected response from the page.');
    }
    return response.result;
};

const App = () => {
    const manifest = browser.runtime.getManifest();
    const [limitInput, setLimitInput] = useState<string>('');
    const [busyAction, setBusyAction] = useState<BusyAction>(null);
    const [status, setStatus] = useState<StatusState | null>(null);

    useEffect(() => {
        const loadPersistedLimit = async () => {
            try {
                const result = await browser.storage.local.get([STORAGE_KEYS.BULK_EXPORT_LIMIT]);
                const persisted = normalizeBulkExportLimitInput(result[STORAGE_KEYS.BULK_EXPORT_LIMIT]);
                setLimitInput(persisted === DEFAULT_BULK_EXPORT_LIMIT ? '' : String(persisted));
            } catch {
                setLimitInput('');
            }
        };
        void loadPersistedLimit();
    }, []);

    const runAction = async (action: Exclude<BusyAction, null>, errorPrefix: string, task: () => Promise<string>) => {
        if (busyAction !== null) {
            return;
        }
        setBusyAction(action);
        setStatus({ kind: 'info', text: 'Working...' });
        try {
            const text = await task();
            setStatus({ kind: 'info', text });
        } catch (error) {
            setStatus({ kind: 'error', text: `${errorPrefix}${errorMessage(error)}` });
        } finally {
            setBusyAction(null);
        }
    };

    const handleExportChats = () => {
        void runAction('export-chats', 'Export failed: ', async () => {
            const message = createExportChatsMessage(limitInput);
            setLimitInput(message.limit === DEFAULT_BULK_EXPORT_LIMIT ? '' : String(message.limit));
            try {
                await browser.storage.local.set({ [STORAGE_KEYS.BULK_EXPORT_LIMIT]: message.limit });
            } catch {
                // Non-fatal: export proceeds even if the limit cannot be persisted.
            }
            const result = await sendToActiveTab(message);
            return formatBulkExportStatus(result);
        });
    };

    const handleExportStreamDebug = () => {
        void runAction('export-stream-debug', 'Stream debug export failed: ', async () => {
            const result = await sendToActiveTab(createExportStreamDebugMessage());
            const records = Array.isArray(result) ? result : [];
            const downloaded = downloadAsJSON(records, `blackiya-stream-debug-${generateTimestamp()}`);
            if (!downloaded) {
                throw new Error('Could not download stream debug JSON.');
            }
            return formatStreamDebugExportedStatus();
        });
    };

    const handleClearStreamDebug = () => {
        void runAction('clear-stream-debug', 'Stream debug clear failed: ', async () => {
            await sendToActiveTab(createClearStreamDebugMessage());
            return formatStreamDebugClearedStatus();
        });
    };

    const isBusy = (action: BusyAction) => busyAction !== null || busyAction === action;

    return (
        <div>
            <div className="title-row">
                <div className="title">
                    <img src="/icon/32.png" width="24" height="24" alt="Icon" />
                    Blackiya
                </div>
            </div>

            <div className="section">
                <div className="section-heading">Export Chats</div>
                <div className="split-row">
                    <button
                        type="button"
                        id="popup-export-chats"
                        className="primary split-row-button"
                        onClick={handleExportChats}
                        disabled={isBusy('export-chats')}
                    >
                        {busyAction === 'export-chats' ? 'Exporting Chats...' : 'Export Chats'}
                    </button>
                    <input
                        id="bulkExportLimit"
                        type="number"
                        min={0}
                        value={limitInput}
                        onChange={(event) => setLimitInput(event.currentTarget.value)}
                        placeholder="Max chats (0 = all)"
                    />
                </div>
            </div>

            <div className="section">
                <div className="section-heading">Stream Debug</div>
                <div className="button-row">
                    <button
                        type="button"
                        id="popup-export-stream-debug"
                        className="primary compact-button"
                        onClick={handleExportStreamDebug}
                        disabled={isBusy('export-stream-debug')}
                    >
                        Export Stream Debug
                    </button>
                    <button
                        type="button"
                        id="popup-clear-stream-debug"
                        className="secondary compact-button"
                        onClick={handleClearStreamDebug}
                        disabled={isBusy('clear-stream-debug')}
                    >
                        Clear Stream Debug
                    </button>
                </div>
            </div>

            <div className="status-row" role="status" aria-live="polite">
                {status ? (
                    <div className={`status-text${status.kind === 'error' ? ' status-error' : ''}`}>{status.text}</div>
                ) : null}
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
