/**
 * Pure helpers for the save / force-save export flow.
 * No runner-state dependencies — fully testable in isolation.
 */

import type { ExportMeta } from '@/utils/sfe/types';

/**
 * Builds the export metadata to attach when saving a conversation.
 * Degraded (force-save) exports get fixed low-fidelity meta; canonical saves
 * use the stored capture meta for the conversation.
 */
export const buildExportMetaForSave = (
    conversationId: string,
    allowDegraded: boolean | undefined,
    getCaptureMeta: (conversationId: string) => ExportMeta,
): ExportMeta => {
    if (allowDegraded === true) {
        return { captureSource: 'dom_snapshot_degraded', fidelity: 'degraded', completeness: 'partial' };
    }
    return getCaptureMeta(conversationId);
};

/**
 * Shows a browser confirm dialog warning the user about degraded force-save
 * data quality. Returns `true` when the user confirms (or when
 * `window.confirm` is unavailable in the current environment).
 */
export const confirmDegradedForceSave = (): boolean => {
    if (typeof window.confirm !== 'function') {
        return true;
    }
    return window.confirm('Force Save may export partial data because canonical capture timed out. Continue?');
};
