import { browser } from 'wxt/browser';
import { logger } from '@/utils/logger';
import type { RawCaptureSnapshot } from '@/utils/runner/calibration-capture';
import { EXPORT_FORMAT, type ExportFormat, STORAGE_KEYS } from '@/utils/settings';
import type { ReadinessDecision } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

const LEGACY_EXPORT_FORMAT_KEY = 'exportFormat';

const normalizeExportFormat = (value: unknown): ExportFormat | null => {
    if (value === EXPORT_FORMAT.COMMON || value === EXPORT_FORMAT.ORIGINAL) {
        return value;
    }
    return null;
};

export const getExportFormat = async (defaultFormat: ExportFormat): Promise<ExportFormat> => {
    const readAreaFormats = async (area: 'local' | 'sync'): Promise<ExportFormat | null> => {
        try {
            const storageArea = area === 'local' ? browser.storage.local : browser.storage.sync;
            const result = await storageArea.get([STORAGE_KEYS.EXPORT_FORMAT, LEGACY_EXPORT_FORMAT_KEY]);
            return (
                normalizeExportFormat(result[STORAGE_KEYS.EXPORT_FORMAT]) ??
                normalizeExportFormat(result[LEGACY_EXPORT_FORMAT_KEY])
            );
        } catch (error) {
            logger.warn(`Failed to read ${area} export format keys`, error);
            return null;
        }
    };

    return (await readAreaFormats('local')) ?? (await readAreaFormats('sync')) ?? defaultFormat;
};

export type StreamProbeVisibilitySettingDeps = {
    setStreamProbeVisible: (visible: boolean) => void;
    getStreamProbeVisible: () => boolean;
    removeStreamProbePanel: () => void;
};

export const loadStreamProbeVisibilitySetting = async (deps: StreamProbeVisibilitySettingDeps) => {
    try {
        const result = await browser.storage.local.get(STORAGE_KEYS.STREAM_PROBE_VISIBLE);
        deps.setStreamProbeVisible(result[STORAGE_KEYS.STREAM_PROBE_VISIBLE] === true);
    } catch (error) {
        logger.warn('Failed to load stream probe visibility setting', error);
        deps.setStreamProbeVisible(false);
    }
    if (!deps.getStreamProbeVisible()) {
        deps.removeStreamProbePanel();
    }
};

export type StorageChangeListenerDeps = {
    setStreamProbeVisible: (visible: boolean) => void;
    removeStreamProbePanel: () => void;
    setSfeEnabled: (enabled: boolean) => void;
    refreshButtonState: (conversationId?: string) => void;
    getCurrentConversationId: () => string | null;
    hasAdapter: () => boolean;
    handleCalibrationProfilesChanged: () => void;
};

export const createStorageChangeListener = (deps: StorageChangeListenerDeps) => {
    const listener: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, areaName) => {
        if (areaName !== 'local') {
            return;
        }
        if (changes[STORAGE_KEYS.STREAM_PROBE_VISIBLE]) {
            const visible = changes[STORAGE_KEYS.STREAM_PROBE_VISIBLE]?.newValue === true;
            deps.setStreamProbeVisible(visible);
            if (!visible) {
                deps.removeStreamProbePanel();
            }
        }
        if (changes[STORAGE_KEYS.SFE_ENABLED]) {
            deps.setSfeEnabled(changes[STORAGE_KEYS.SFE_ENABLED]?.newValue !== false);
            deps.refreshButtonState(deps.getCurrentConversationId() ?? undefined);
        }
        if (changes[STORAGE_KEYS.CALIBRATION_PROFILES] && deps.hasAdapter()) {
            deps.handleCalibrationProfilesChanged();
        }
    };
    return listener;
};

export type VisibilityRecoveryDeps = {
    resolveConversationId: () => string | null;
    getCurrentConversationId: () => string | null;
    resolveReadinessDecision: (conversationId: string) => ReadinessDecision;
    resolveAttemptId: (conversationId?: string) => string;
    maybeRestartCanonicalRecoveryAfterTimeout: (conversationId: string, attemptId: string) => void;
    requestPageSnapshot: (conversationId: string) => Promise<unknown | null>;
    isConversationDataLike: (value: unknown) => value is ConversationData;
    isRawCaptureSnapshot: (value: unknown) => value is RawCaptureSnapshot;
    ingestConversationData: (data: ConversationData, source: string) => void;
    ingestInterceptedData: (args: { url: string; data: string; platform: string }) => void;
    getRawSnapshotReplayUrls: (conversationId: string, snapshot: { url: string }) => string[];
    getPlatformName: () => string;
    getConversation: (conversationId: string) => ConversationData | undefined;
    evaluateReadinessForData: (data: ConversationData) => { ready: boolean };
    markCanonicalCaptureMeta: (conversationId: string) => void;
    ingestSfeCanonicalSample: (data: ConversationData, attemptId?: string) => unknown;
    refreshButtonState: (conversationId?: string) => void;
    warmFetchConversationSnapshot: (conversationId: string, reason: 'force-save') => Promise<boolean>;
};

const replayRawVisibilitySnapshot = (
    conversationId: string,
    snapshot: RawCaptureSnapshot,
    deps: VisibilityRecoveryDeps,
) => {
    for (const replayUrl of deps.getRawSnapshotReplayUrls(conversationId, snapshot)) {
        deps.ingestInterceptedData({
            url: replayUrl,
            data: snapshot.data,
            platform: snapshot.platform ?? deps.getPlatformName(),
        });
        const cachedAfterReplay = deps.getConversation(conversationId);
        if (cachedAfterReplay && deps.evaluateReadinessForData(cachedAfterReplay).ready) {
            break;
        }
    }
};

const ingestVisibilitySnapshot = (conversationId: string, snapshot: unknown, deps: VisibilityRecoveryDeps): boolean => {
    if (deps.isConversationDataLike(snapshot)) {
        deps.ingestConversationData(snapshot, 'visibility-recovery-snapshot');
        return true;
    }
    if (!deps.isRawCaptureSnapshot(snapshot)) {
        return false;
    }
    replayRawVisibilitySnapshot(conversationId, snapshot, deps);
    return true;
};

const finalizeVisibilityRecovery = (conversationId: string, attemptId: string, deps: VisibilityRecoveryDeps) => {
    const cached = deps.getConversation(conversationId);
    if (!cached) {
        return;
    }
    if (deps.evaluateReadinessForData(cached).ready) {
        deps.markCanonicalCaptureMeta(conversationId);
        deps.ingestSfeCanonicalSample(cached, attemptId);
    }
    deps.refreshButtonState(conversationId);
};

export const createVisibilityChangeHandler = (deps: VisibilityRecoveryDeps) => {
    return () => {
        if (document.hidden) {
            return;
        }
        const routeConversationId = deps.resolveConversationId();
        const fallbackConversationId = deps.getCurrentConversationId();
        const conversationId = routeConversationId ?? fallbackConversationId;
        if (!conversationId) {
            return;
        }
        if (
            !routeConversationId &&
            fallbackConversationId &&
            typeof window?.location?.href === 'string' &&
            !window.location.href.includes(fallbackConversationId)
        ) {
            return;
        }
        if (deps.resolveReadinessDecision(conversationId).mode === 'canonical_ready') {
            return;
        }
        logger.info('Tab became visible — reattempting capture', { conversationId });
        const attemptId = deps.resolveAttemptId(conversationId);
        deps.maybeRestartCanonicalRecoveryAfterTimeout(conversationId, attemptId);
        void deps.requestPageSnapshot(conversationId).then((snapshot) => {
            if (!snapshot || !ingestVisibilitySnapshot(conversationId, snapshot, deps)) {
                return;
            }
            finalizeVisibilityRecovery(conversationId, attemptId, deps);
        });
        void deps.warmFetchConversationSnapshot(conversationId, 'force-save').then(() => {
            deps.refreshButtonState(conversationId);
        });
    };
};

export const scheduleButtonInjectionRetries = (
    injectSaveButton: () => void,
    buttonManagerExists: () => boolean,
    delays = [1000, 2000, 5000],
) =>
    delays.map((delay) =>
        window.setTimeout(() => {
            if (!buttonManagerExists()) {
                injectSaveButton();
            }
        }, delay),
    );
