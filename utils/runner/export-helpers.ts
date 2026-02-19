/**
 * Pure utilities for building and annotating export payloads.
 * No runner state dependencies — fully testable in isolation.
 */

import { buildCommonExport } from '@/utils/common-export';
import { logger } from '@/utils/logger';
import type { ExportFormat } from '@/utils/settings';
import type { ExportMeta } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

/**
 * Serialises conversation data into the requested export format.
 * Falls back to the original format when `common` conversion throws.
 */
export const buildExportPayloadForFormat = (
    data: ConversationData,
    format: ExportFormat,
    platformName: string,
): unknown => {
    if (format !== 'common') {
        return data;
    }
    try {
        return buildCommonExport(data, platformName);
    } catch (error) {
        logger.error('Failed to build common export format, falling back to original.', error);
        return data;
    }
};

/**
 * Merges export metadata into the `__blackiya.exportMeta` field of a payload object.
 * Non-object payloads are returned unchanged.
 */
export const attachExportMeta = (payload: unknown, meta: ExportMeta): unknown => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return payload;
    }
    const record = payload as Record<string, unknown>;
    const existingBlackiya =
        record.__blackiya && typeof record.__blackiya === 'object'
            ? (record.__blackiya as Record<string, unknown>)
            : {};
    return {
        ...record,
        __blackiya: {
            ...existingBlackiya,
            exportMeta: meta,
        },
    };
};
