/**
 * Settings Utilities
 *
 * Shared keys and defaults for user-configurable settings.
 *
 * @module utils/settings
 */

export const STORAGE_KEYS = {
    LOG_LEVEL: 'userSettings.logLevel',
    CALIBRATION_PROFILES: 'userSettings.calibrationProfiles',
    SFE_ENABLED: 'userSettings.sfe.enabled',
    STREAM_PROBE_VISIBLE: 'userSettings.ui.streamProbeVisible',
    BULK_EXPORT_LIMIT: 'userSettings.bulkExport.limit',
} as const;

export const DEFAULT_BULK_EXPORT_LIMIT = 0;
export const DEFAULT_BULK_EXPORT_DELAY_MS = 1_200;
export const DEFAULT_BULK_EXPORT_TIMEOUT_MS = 20_000;
