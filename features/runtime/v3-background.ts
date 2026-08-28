import { type BulkExportProgressMessage, isBulkExportProgressMessage } from '@/features/bulk-export/contract';

export type V3BackgroundActionApi = {
    setBadgeText: (details: { text: string; tabId?: number }) => Promise<void> | void;
    setBadgeBackgroundColor?: (details: { color: string; tabId?: number }) => Promise<void> | void;
    setTitle?: (details: { title: string; tabId?: number }) => Promise<void> | void;
};

export type V3BackgroundSender = {
    tab?: { id?: number };
};

const toBadgeCounterText = (value: number | undefined): string => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return '';
    }
    const normalized = Math.floor(value);
    return normalized > 999 ? '999+' : String(normalized);
};

const showCompletedExport = (actionApi: V3BackgroundActionApi, tabId: number, message: BulkExportProgressMessage) => {
    void actionApi.setBadgeText({ text: '', tabId });
    void actionApi.setTitle?.({
        title: `Blackiya: Export completed (${message.exported ?? 0}/${message.attempted ?? 0})`,
        tabId,
    });
};

const showFailedExport = (actionApi: V3BackgroundActionApi, tabId: number, message: BulkExportProgressMessage) => {
    void actionApi.setBadgeText({ text: '!', tabId });
    void actionApi.setBadgeBackgroundColor?.({ color: '#b91c1c', tabId });
    void actionApi.setTitle?.({
        title: `Blackiya: Export failed${message.message ? ` - ${message.message}` : ''}`,
        tabId,
    });
};

const showActiveExport = (actionApi: V3BackgroundActionApi, tabId: number, message: BulkExportProgressMessage) => {
    void actionApi.setBadgeText({ text: toBadgeCounterText(message.remaining), tabId });
    void actionApi.setBadgeBackgroundColor?.({ color: '#1d4ed8', tabId });
    void actionApi.setTitle?.({
        title: `Blackiya: Exporting ${message.platform ?? 'chats'} (${message.attempted ?? 0}/${message.discovered ?? 0})`,
        tabId,
    });
};

export const createV3BackgroundMessageHandler = (actionApi: V3BackgroundActionApi | null) => {
    return (message: unknown, sender: V3BackgroundSender): boolean => {
        if (!isBulkExportProgressMessage(message)) {
            return false;
        }

        const tabId = sender.tab?.id;
        if (!actionApi || typeof tabId !== 'number') {
            return true;
        }

        if (message.stage === 'completed') {
            showCompletedExport(actionApi, tabId, message);
            return true;
        }

        if (message.stage === 'failed') {
            showFailedExport(actionApi, tabId, message);
            return true;
        }

        showActiveExport(actionApi, tabId, message);
        return true;
    };
};
