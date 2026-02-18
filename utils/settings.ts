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
    DIAGNOSTICS_STREAM_DUMP_ENABLED: 'userSettings.diagnostics.streamDumpEnabled',
    DIAGNOSTICS_STREAM_DUMP_STORE: 'diagnostics.streamDumpStore',
} as const;

export type ExportFormat = 'original' | 'common';

export const DEFAULT_EXPORT_FORMAT: ExportFormat = 'original';
