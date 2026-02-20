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

/**
 * Extracts human-readable response text from a ConversationData for display
 * in the stream probe panel. Tries the common export format first (which gives
 * the cleanest `response` field), then falls back to raw assistant message parts.
 */
export const extractResponseTextFromConversation = (data: ConversationData, platformName: string): string => {
    try {
        const common = buildCommonExport(data, platformName) as {
            response?: string | null;
            prompt?: string | null;
        };
        const response = (common.response ?? '').trim();
        const prompt = (common.prompt ?? '').trim();
        if (response) {
            return response;
        }
        if (prompt) {
            return `(No assistant response found yet)\nPrompt: ${prompt}`;
        }
    } catch {
        // fall through to raw extraction
    }
    return Object.values(data.mapping)
        .map((node) => node.message)
        .filter((msg): msg is NonNullable<(typeof data.mapping)[string]['message']> => !!msg)
        .filter((msg) => msg.author.role === 'assistant')
        .flatMap((msg) => msg.content.parts ?? [])
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
        .join('\n\n')
        .trim();
};
