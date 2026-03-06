/**
 * Pure utilities for building and annotating export payloads.
 * No runner state dependencies — fully testable in isolation.
 */

import { extractAllAssistantText, extractLatestTurnPromptAndResponse } from '@/utils/conversation-inspection';
import type { ExportMeta } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

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
 * in the stream probe panel. Prefers the latest turn's assistant response,
 * then falls back to the latest prompt, then all assistant message text.
 */
export const extractResponseTextFromConversation = (data: ConversationData, _platformName?: string): string => {
    if (!data.current_node || !data.mapping[data.current_node]?.message) {
        return extractAllAssistantText(data);
    }
    const latestTurn = extractLatestTurnPromptAndResponse(data);
    if (latestTurn.response) {
        return latestTurn.response;
    }
    if (latestTurn.prompt) {
        return `(No assistant response found yet)\nPrompt: ${latestTurn.prompt}`;
    }
    return extractAllAssistantText(data);
};
