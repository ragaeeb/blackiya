/**
 * Save pipeline — orchestrates the full save/export flow.
 *
 * Handles data retrieval, readiness gating, title fallback resolution,
 * force-save recovery, and the final export-to-download step.
 * All runner-state access goes through the injected deps object.
 */

import type { LLMPlatform } from '@/platforms/types';
import { downloadAsJSON } from '@/utils/download';
import { logger } from '@/utils/logger';
import type { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import { attachExportMeta, buildExportPayloadForFormat } from '@/utils/runner/export-helpers';
import { applyResolvedExportTitle } from '@/utils/runner/export-pipeline';
import { buildExportMetaForSave, confirmDegradedForceSave } from '@/utils/runner/save-export';
import type { ExportFormat } from '@/utils/settings';
import type { ExportMeta, PlatformReadiness, ReadinessDecision } from '@/utils/sfe/types';
import {
    deriveConversationTitleFromFirstUserMessage,
    resolveConversationTitleByPrecedence,
} from '@/utils/title-resolver';
import type { ConversationData } from '@/utils/types';

export type SavePipelineDeps = {
    getAdapter: () => LLMPlatform | null;
    resolveConversationIdForUserAction: () => string | null;
    getConversation: (conversationId: string) => ConversationData | undefined;
    resolveReadinessDecision: (conversationId: string) => ReadinessDecision;
    shouldBlockActionsForGeneration: (conversationId: string) => boolean;
    getCaptureMeta: (conversationId: string) => ExportMeta;
    getExportFormat: () => Promise<ExportFormat>;
    getStreamResolvedTitle: (conversationId: string) => string | null;
    evaluateReadinessForData: (data: ConversationData) => PlatformReadiness;
    markCanonicalCaptureMeta: (conversationId: string) => void;
    ingestSfeCanonicalSample: (data: ConversationData, attemptId?: string) => unknown;
    resolveAttemptId: (conversationId?: string) => string;
    peekAttemptId: (conversationId?: string) => string | null;
    refreshButtonState: (conversationId?: string) => void;
    requestPageSnapshot: (conversationId: string) => Promise<unknown | null>;
    warmFetchConversationSnapshot: (conversationId: string, reason: 'force-save') => Promise<boolean>;
    ingestConversationData: (data: ConversationData, source: string) => void;
    isConversationDataLike: (data: unknown) => data is ConversationData;
    buttonManagerExists: () => boolean;
    buttonManagerSetLoading: (loading: boolean, button: 'save') => void;
    buttonManagerSetSuccess: (button: 'save') => void;
    structuredLogger: StructuredAttemptLogger;
};

const resolveConversationIdOrNotify = (silent: boolean | undefined, deps: SavePipelineDeps): string | null => {
    const conversationId = deps.resolveConversationIdForUserAction();
    if (conversationId) {
        return conversationId;
    }
    logger.error('No conversation ID found in URL');
    if (!silent) {
        alert('Please select a conversation first.');
    }
    return null;
};

const resolveCapturedConversationOrNotify = (
    conversationId: string,
    silent: boolean | undefined,
    deps: SavePipelineDeps,
): ConversationData | null => {
    const data = deps.getConversation(conversationId);
    if (data) {
        return data;
    }
    logger.warn('No data captured for this conversation yet.');
    if (!silent) {
        alert('Conversation data not yet captured. Please refresh the page or wait for the conversation to load.');
    }
    return null;
};

const canExportConversationData = (
    conversationId: string,
    allowDegraded: boolean,
    silent: boolean | undefined,
    deps: SavePipelineDeps,
): boolean => {
    const decision = deps.resolveReadinessDecision(conversationId);
    const canExportNow =
        decision.mode === 'canonical_ready' || (allowDegraded && decision.mode === 'degraded_manual_only');
    if (canExportNow && !deps.shouldBlockActionsForGeneration(conversationId)) {
        return true;
    }
    const adapter = deps.getAdapter();
    logger.warn('Conversation is still generating; export blocked until completion.', {
        conversationId,
        platform: adapter?.name ?? 'Unknown',
        reason: decision.reason,
    });
    if (!silent) {
        alert(
            decision.mode === 'degraded_manual_only'
                ? 'Canonical capture timed out. Use Force Save to export potentially incomplete data.'
                : 'Response is still generating. Please wait for completion, then try again.',
        );
    }
    return false;
};

export const applyTitleDomFallbackIfNeeded = (
    conversationId: string,
    data: ConversationData,
    deps: SavePipelineDeps,
) => {
    const adapter = deps.getAdapter();
    if (!adapter?.extractTitleFromDom || !adapter.defaultTitles) {
        return;
    }
    const streamTitle = deps.getStreamResolvedTitle(conversationId);
    const domTitle = adapter.extractTitleFromDom();
    const promptDerivedTitle = deriveConversationTitleFromFirstUserMessage(data);
    const titleDecision = resolveConversationTitleByPrecedence({
        streamTitle,
        cachedTitle: data.title ?? null,
        domTitle,
        firstUserMessageTitle: promptDerivedTitle,
        fallbackTitle: data.title ?? 'Conversation',
        platformDefaultTitles: adapter.defaultTitles,
    });
    const currentTitle = (data.title ?? '').trim();
    logger.info('Title fallback check', {
        conversationId,
        adapter: adapter.name,
        streamTitle,
        cachedTitle: currentTitle || null,
        domTitle: domTitle ?? null,
        resolvedSource: titleDecision.source,
        resolvedTitle: titleDecision.title,
    });
    if (titleDecision.title !== currentTitle) {
        logger.info('Title resolved from shared fallback policy', {
            conversationId,
            oldTitle: data.title,
            newTitle: titleDecision.title,
            source: titleDecision.source,
        });
        data.title = titleDecision.title;
    }
};

export const getConversationData = async (
    options: { silent?: boolean; allowDegraded?: boolean },
    deps: SavePipelineDeps,
): Promise<ConversationData | null> => {
    if (!deps.getAdapter()) {
        return null;
    }
    const conversationId = resolveConversationIdOrNotify(options.silent, deps);
    if (!conversationId) {
        return null;
    }
    const data = resolveCapturedConversationOrNotify(conversationId, options.silent, deps);
    if (!data) {
        return null;
    }
    if (!canExportConversationData(conversationId, options.allowDegraded === true, options.silent, deps)) {
        return null;
    }
    applyTitleDomFallbackIfNeeded(conversationId, data, deps);
    return data;
};

const buildExportPayload = async (
    data: ConversationData,
    meta: ExportMeta,
    deps: SavePipelineDeps,
): Promise<unknown> => {
    const format = await deps.getExportFormat();
    const adapter = deps.getAdapter();
    return attachExportMeta(buildExportPayloadForFormat(data, format, adapter?.name ?? 'Unknown'), meta);
};

export const saveConversation = async (
    data: ConversationData,
    options: { allowDegraded?: boolean },
    deps: SavePipelineDeps,
): Promise<boolean> => {
    const adapter = deps.getAdapter();
    if (!adapter) {
        return false;
    }
    if (deps.buttonManagerExists()) {
        deps.buttonManagerSetLoading(true, 'save');
    }
    try {
        const cachedTitle = data.title ?? null;
        const titleDecision = applyResolvedExportTitle(data);
        logger.info('Export title decision', {
            conversationId: data.conversation_id,
            adapter: adapter.name,
            source: titleDecision.source,
            cachedTitle,
            resolvedTitle: titleDecision.title,
        });
        const filename = adapter.formatFilename(data);
        const exportMeta = buildExportMetaForSave(data.conversation_id, options.allowDegraded, deps.getCaptureMeta);
        const exportPayload = await buildExportPayload(data, exportMeta, deps);
        downloadAsJSON(exportPayload, filename);
        logger.info(`Saved conversation: ${filename}.json`);
        if (options.allowDegraded === true) {
            deps.structuredLogger.emit(
                deps.peekAttemptId(data.conversation_id) ?? 'unknown',
                'warn',
                'force_save_degraded_export',
                'Degraded manual export forced by user',
                { conversationId: data.conversation_id },
                `force-save-degraded:${data.conversation_id}`,
            );
        }
        if (deps.buttonManagerExists()) {
            deps.buttonManagerSetSuccess('save');
        }
        return true;
    } catch (error) {
        logger.error('Failed to save conversation:', error);
        alert('Failed to save conversation. Check console for details.');
        if (deps.buttonManagerExists()) {
            deps.buttonManagerSetLoading(false, 'save');
        }
        return false;
    }
};

export const resolveSaveReadiness = (
    conversationId: string | null,
    deps: SavePipelineDeps,
): { conversationId: string; decision: ReadinessDecision; allowDegraded: boolean } | null => {
    if (!conversationId) {
        return null;
    }
    const decision = deps.resolveReadinessDecision(conversationId);
    return { conversationId, decision, allowDegraded: decision.mode === 'degraded_manual_only' };
};

export const maybeIngestFreshSnapshotForForceSave = (
    conversationId: string,
    freshSnapshot: unknown,
    deps: SavePipelineDeps,
): boolean => {
    if (!freshSnapshot || !deps.isConversationDataLike(freshSnapshot)) {
        return false;
    }
    deps.ingestConversationData(freshSnapshot, 'force-save-snapshot-recovery');
    const cached = deps.getConversation(conversationId);
    if (!cached) {
        return false;
    }
    if (!deps.evaluateReadinessForData(cached).ready) {
        return false;
    }
    deps.markCanonicalCaptureMeta(conversationId);
    deps.ingestSfeCanonicalSample(cached, deps.resolveAttemptId(conversationId));
    deps.refreshButtonState(conversationId);
    logger.info('Force Save recovered via fresh snapshot — using canonical path', { conversationId });
    return true;
};

export const recoverCanonicalBeforeForceSave = async (
    conversationId: string,
    deps: SavePipelineDeps,
): Promise<boolean> => {
    const freshSnapshot = await deps.requestPageSnapshot(conversationId);
    if (maybeIngestFreshSnapshotForForceSave(conversationId, freshSnapshot, deps)) {
        return true;
    }
    await deps.warmFetchConversationSnapshot(conversationId, 'force-save');
    deps.refreshButtonState(conversationId);
    return deps.resolveReadinessDecision(conversationId).mode !== 'degraded_manual_only';
};

export const handleSaveClick = async (deps: SavePipelineDeps): Promise<void> => {
    if (!deps.getAdapter()) {
        return;
    }
    const readiness = resolveSaveReadiness(deps.resolveConversationIdForUserAction(), deps);
    if (!readiness) {
        return;
    }
    let allowDegraded = readiness.allowDegraded;
    if (allowDegraded) {
        const recovered = await recoverCanonicalBeforeForceSave(readiness.conversationId, deps);
        allowDegraded = !recovered;
    }
    if (allowDegraded && !confirmDegradedForceSave()) {
        return;
    }
    const data = await getConversationData({ allowDegraded }, deps);
    if (!data) {
        return;
    }
    await saveConversation(data, { allowDegraded }, deps);
};
