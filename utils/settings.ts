import { browser } from 'wxt/browser';

/**
 * Settings Utilities
 *
 * Shared keys and defaults for user-configurable settings.
 *
 * @module utils/settings
 */

export const STORAGE_KEYS = {
    EXTENSION_ENABLED: 'userSettings.extension.enabled',
    LOG_LEVEL: 'userSettings.logLevel',
    CALIBRATION_PROFILES: 'userSettings.calibrationProfiles',
    SFE_ENABLED: 'userSettings.sfe.enabled',
    STREAM_PROBE_VISIBLE: 'userSettings.ui.streamProbeVisible',
    BULK_EXPORT_LIMIT: 'userSettings.bulkExport.limit',
} as const;

export const DEFAULT_EXTENSION_ENABLED = true;
export const DEFAULT_BULK_EXPORT_LIMIT = 0;
export const DEFAULT_BULK_EXPORT_DELAY_MS = 1_200;
export const DEFAULT_BULK_EXPORT_TIMEOUT_MS = 20_000;

export const isExtensionEnabledValue = (value: unknown) => value !== false;

export const loadExtensionEnabledSetting = async () => {
    try {
        const result = await browser.storage.local.get(STORAGE_KEYS.EXTENSION_ENABLED);
        return isExtensionEnabledValue(result[STORAGE_KEYS.EXTENSION_ENABLED]);
    } catch {
        return DEFAULT_EXTENSION_ENABLED;
    }
};
