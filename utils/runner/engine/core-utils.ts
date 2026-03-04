import type { LLMPlatform } from '@/platforms/types';
import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import type { StreamDumpConfigMessage } from '@/utils/protocol/messages';
import { stampToken } from '@/utils/protocol/session-token';
import { isConversationDataLike, isRawCaptureSnapshot } from '@/utils/runner/calibration-capture';
import { buildIsolatedDomSnapshot } from '@/utils/runner/dom-snapshot';
import type { EngineCtx } from '@/utils/runner/engine/types';
import { buildExportPayloadForFormat as buildExportPayloadForFormatPure } from '@/utils/runner/export-helpers';
import { detectPlatformGenerating } from '@/utils/runner/generation-guard';
import { evaluateReadinessForData as evaluateReadinessForDataPure } from '@/utils/runner/readiness-evaluation';
import { getExportFormat as getExportFormatCore } from '@/utils/runner/runtime/runtime-settings';
import { DEFAULT_EXPORT_FORMAT, type ExportFormat } from '@/utils/settings';
import type { ExportMeta, PlatformReadiness } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

export const extractConversationIdFromLocation = (ctx: EngineCtx): string | null => {
    if (!ctx.currentAdapter) {
        return null;
    }
    return ctx.currentAdapter.extractConversationId(window.location.href) || null;
};

export const resolveConversationIdForUserAction = (ctx: EngineCtx): string | null => {
    const locationId = extractConversationIdFromLocation(ctx);
    if (locationId) {
        return locationId;
    }
    if (ctx.currentConversationId && window.location.href.includes(ctx.currentConversationId)) {
        return ctx.currentConversationId;
    }
    return null;
};

export const getCaptureMeta = (ctx: EngineCtx, conversationId: string): ExportMeta =>
    ctx.captureMetaByConversation.get(conversationId) ?? {
        captureSource: 'canonical_api',
        fidelity: 'high',
        completeness: 'complete',
    };

export const resolveIsolatedSnapshotData = (ctx: EngineCtx, conversationId: string): ConversationData | null => {
    if (!ctx.currentAdapter) {
        return null;
    }
    return buildIsolatedDomSnapshot(ctx.currentAdapter, conversationId);
};

export const evaluateReadinessForData = (ctx: EngineCtx, data: ConversationData): PlatformReadiness =>
    evaluateReadinessForDataPure(data, ctx.currentAdapter);

export const ingestStabilizationRetrySnapshot = (ctx: EngineCtx, conversationId: string, data: unknown) => {
    if (isConversationDataLike(data)) {
        ctx.interceptionManager.ingestConversationData(data, 'stabilization-retry-snapshot');
        return;
    }
    if (isRawCaptureSnapshot(data)) {
        ctx.interceptionManager.ingestInterceptedData({
            url: data.url,
            data: data.data,
            platform: data.platform ?? ctx.currentAdapter?.name ?? 'unknown',
        });
        return;
    }
    ctx.interceptionManager.ingestInterceptedData({
        url: `stabilization-retry-snapshot://${ctx.currentAdapter?.name ?? 'unknown'}/${conversationId}`,
        data: JSON.stringify(data),
        platform: ctx.currentAdapter?.name ?? 'unknown',
    });
};

export const isPlatformGenerating = (adapter: LLMPlatform | null): boolean => detectPlatformGenerating(adapter);

export const isLifecycleGenerationPhase = (ctx: EngineCtx, conversationId: string): boolean => {
    if (ctx.lifecycleState !== 'prompt-sent' && ctx.lifecycleState !== 'streaming') {
        return false;
    }
    if (!ctx.currentConversationId) {
        return true;
    }
    return ctx.currentConversationId === conversationId;
};

export const shouldBlockActionsForGeneration = (ctx: EngineCtx, conversationId: string): boolean => {
    if (isLifecycleGenerationPhase(ctx, conversationId)) {
        return true;
    }
    if (ctx.currentAdapter?.name !== 'ChatGPT') {
        return false;
    }
    return isPlatformGenerating(ctx.currentAdapter);
};

export const emitStreamDumpConfig = (ctx: EngineCtx) => {
    const payload: StreamDumpConfigMessage = { type: MESSAGE_TYPES.STREAM_DUMP_CONFIG, enabled: ctx.streamDumpEnabled };
    window.postMessage(stampToken(payload), window.location.origin);
};

export const buildExportPayloadForFormat = (ctx: EngineCtx, data: ConversationData, format: ExportFormat): unknown =>
    buildExportPayloadForFormatPure(data, format, ctx.currentAdapter?.name ?? 'Unknown');

export const getExportFormat = (): Promise<ExportFormat> => getExportFormatCore(DEFAULT_EXPORT_FORMAT);
