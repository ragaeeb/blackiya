/**
 * Settings Utilities
 *
 * Shared keys and defaults for user-configurable settings.
 *
 * @module utils/settings
 */

export const STORAGE_KEYS = {
    LOG_LEVEL: 'userSettings.logLevel',
    EXPORT_FORMAT: 'userSettings.exportFormat',
    CALIBRATION_PROFILES: 'userSettings.calibrationProfiles',
    SFE_ENABLED: 'userSettings.sfe.enabled',
    STREAM_PROBE_VISIBLE: 'userSettings.ui.streamProbeVisible',
    DIAGNOSTICS_STREAM_DUMP_ENABLED: 'userSettings.diagnostics.streamDumpEnabled',
    DIAGNOSTICS_STREAM_DUMP_STORE: 'diagnostics.streamDumpStore',
} as const;

export const EXPORT_FORMAT = {
    ORIGINAL: 'original',
    COMMON: 'common',
} as const;

export const EXPORT_FORMAT_VALUES = [EXPORT_FORMAT.ORIGINAL, EXPORT_FORMAT.COMMON] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];

export const DEFAULT_EXPORT_FORMAT: ExportFormat = EXPORT_FORMAT.ORIGINAL;
