import { browser } from 'wxt/browser';
import { logger } from '@/utils/logger';
import { type ExportFormat, STORAGE_KEYS } from '@/utils/settings';
import type { ReadinessDecision } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

export const getExportFormat = async (defaultFormat: ExportFormat): Promise<ExportFormat> => {
    try {
        const result = await browser.storage.local.get(STORAGE_KEYS.EXPORT_FORMAT);
        const value = result[STORAGE_KEYS.EXPORT_FORMAT];
        if (value === 'common' || value === 'original') {
            return value;
        }
    } catch (error) {
        logger.warn('Failed to read export format setting, using default.', error);
    }
    return defaultFormat;
};

export type StreamDumpSettingDeps = {
    setStreamDumpEnabled: (enabled: boolean) => void;
    emitStreamDumpConfig: () => void;
};

export const loadStreamDumpSetting = async (deps: StreamDumpSettingDeps) => {
    try {
        const result = await browser.storage.local.get(STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_ENABLED);
        deps.setStreamDumpEnabled(result[STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_ENABLED] === true);
    } catch (error) {
        logger.warn('Failed to load stream dump diagnostics setting', error);
        deps.setStreamDumpEnabled(false);
    }
    deps.emitStreamDumpConfig();
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
    setStreamDumpEnabled: (enabled: boolean) => void;
    emitStreamDumpConfig: () => void;
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
        if (changes[STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_ENABLED]) {
            deps.setStreamDumpEnabled(changes[STORAGE_KEYS.DIAGNOSTICS_STREAM_DUMP_ENABLED]?.newValue === true);
            deps.emitStreamDumpConfig();
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
    ingestConversationData: (data: ConversationData, source: string) => void;
    getConversation: (conversationId: string) => ConversationData | undefined;
    evaluateReadinessForData: (data: ConversationData) => { ready: boolean };
    markCanonicalCaptureMeta: (conversationId: string) => void;
    ingestSfeCanonicalSample: (data: ConversationData, attemptId?: string) => unknown;
    refreshButtonState: (conversationId?: string) => void;
    warmFetchConversationSnapshot: (conversationId: string, reason: 'force-save') => Promise<boolean>;
};

export const createVisibilityChangeHandler = (deps: VisibilityRecoveryDeps) => {
    return () => {
        if (document.hidden) {
            return;
        }
        const conversationId = deps.resolveConversationId() ?? deps.getCurrentConversationId();
        if (!conversationId) {
            return;
        }
        if (deps.resolveReadinessDecision(conversationId).mode === 'canonical_ready') {
            return;
        }
        logger.info('Tab became visible — reattempting capture', { conversationId });
        const attemptId = deps.resolveAttemptId(conversationId);
        deps.maybeRestartCanonicalRecoveryAfterTimeout(conversationId, attemptId);
        void deps.requestPageSnapshot(conversationId).then((snapshot) => {
            if (!snapshot || !deps.isConversationDataLike(snapshot)) {
                return;
            }
            deps.ingestConversationData(snapshot, 'visibility-recovery-snapshot');
            const cached = deps.getConversation(conversationId);
            if (!cached) {
                return;
            }
            if (deps.evaluateReadinessForData(cached).ready) {
                deps.markCanonicalCaptureMeta(conversationId);
                deps.ingestSfeCanonicalSample(cached, attemptId);
            }
            deps.refreshButtonState(conversationId);
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
