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
} as const;

export type ExportFormat = 'original' | 'common';

export const DEFAULT_EXPORT_FORMAT: ExportFormat = 'original';
