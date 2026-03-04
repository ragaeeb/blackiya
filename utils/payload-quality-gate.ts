/**
 * Payload Quality Gate
 *
 * Detects when a conversation.ready event is about to be emitted with
 * degraded data quality (missing model, empty reasoning) and:
 * 1. Logs a structured diagnostic summary
 * 2. Generates a compact debug snapshot for forensic analysis
 * 3. Notifies the content script to show a dismissible error toast
 *
 * Platform-agnostic — works for ChatGPT, Grok, and Gemini.
 *
 * @module utils/payload-quality-gate
 */

import { buildCommonExport } from '@/utils/common-export';
import { logger } from '@/utils/logger';
import type { ExportMeta } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';

export type PayloadQualityIssue = 'missing_model' | 'empty_reasoning';

export type PayloadQualityResult = {
    passed: boolean;
    issues: PayloadQualityIssue[];
    model: string | undefined;
    reasoningCount: number;
    promptLength: number;
    responseLength: number;
};

export type PayloadQualityDiagnostic = {
    api: 'blackiya.payload-quality-diagnostic.v1';
    generatedAtMs: number;
    conversationId: string;
    platform: string;
    eventType: string;
    quality: PayloadQualityResult;
    captureMeta: ExportMeta;
    /** First 2000 chars of serialised ConversationData for forensic analysis. */
    rawDataPreview: string;
    rawDataBytes: number;
    /** Model-related fields from the raw data for quick inspection. */
    modelHints: {
        defaultModelSlug: string | undefined;
        mappingModelSlugs: string[];
        mappingResolvedModelSlugs: string[];
    };
};

/**
 * Evaluates the quality of a common export payload.
 * Returns a result indicating whether the payload passes quality checks.
 */
export const evaluatePayloadQuality = (data: ConversationData, platformName: string): PayloadQualityResult => {
    try {
        const common = buildCommonExport(data, platformName) as {
            model?: string;
            reasoning?: string[];
            prompt?: string;
            response?: string;
        };

        const issues: PayloadQualityIssue[] = [];
        const model = typeof common.model === 'string' && common.model.length > 0 ? common.model : undefined;
        const reasoning = Array.isArray(common.reasoning) ? common.reasoning : [];
        const prompt = typeof common.prompt === 'string' ? common.prompt : '';
        const response = typeof common.response === 'string' ? common.response : '';

        if (!model) {
            issues.push('missing_model');
        }
        if (reasoning.length === 0) {
            issues.push('empty_reasoning');
        }

        return {
            passed: issues.length === 0,
            issues,
            model,
            reasoningCount: reasoning.length,
            promptLength: prompt.length,
            responseLength: response.length,
        };
    } catch (error) {
        logger.warn('Payload quality evaluation failed', {
            error: error instanceof Error ? error.message : String(error),
        });
        return {
            passed: false,
            issues: ['missing_model', 'empty_reasoning'],
            model: undefined,
            reasoningCount: 0,
            promptLength: 0,
            responseLength: 0,
        };
    }
};

/**
 * Extracts model-related metadata hints from the raw ConversationData
 * for quick diagnostic inspection without full parsing.
 */
const extractModelHints = (data: ConversationData): PayloadQualityDiagnostic['modelHints'] => {
    const modelSlugs = new Set<string>();
    const resolvedModelSlugs = new Set<string>();

    for (const node of Object.values(data.mapping)) {
        const meta = node.message?.metadata as Record<string, unknown> | undefined;
        if (!meta) {
            continue;
        }
        if (typeof meta.model_slug === 'string' && meta.model_slug.length > 0) {
            modelSlugs.add(meta.model_slug);
        }
        if (typeof meta.resolved_model_slug === 'string' && meta.resolved_model_slug.length > 0) {
            resolvedModelSlugs.add(meta.resolved_model_slug);
        }
    }

    return {
        defaultModelSlug: data.default_model_slug ?? undefined,
        mappingModelSlugs: [...modelSlugs],
        mappingResolvedModelSlugs: [...resolvedModelSlugs],
    };
};

/**
 * Builds a compact diagnostic snapshot for a quality failure.
 */
export const buildQualityDiagnostic = (
    conversationId: string,
    platformName: string,
    eventType: string,
    quality: PayloadQualityResult,
    captureMeta: ExportMeta,
    data: ConversationData,
): PayloadQualityDiagnostic => {
    const serialised = JSON.stringify(data);
    return {
        api: 'blackiya.payload-quality-diagnostic.v1',
        generatedAtMs: Date.now(),
        conversationId,
        platform: platformName,
        eventType,
        quality,
        captureMeta,
        rawDataPreview: serialised.slice(0, 2000),
        rawDataBytes: serialised.length,
        modelHints: extractModelHints(data),
    };
};

/**
 * Checks payload quality and logs diagnostics if issues are found.
 * Returns the quality result for the caller to decide on further action.
 */
export const runPayloadQualityGate = (
    conversationId: string,
    platformName: string,
    eventType: string,
    captureMeta: ExportMeta,
    data: ConversationData,
): PayloadQualityResult => {
    const quality = evaluatePayloadQuality(data, platformName);

    if (quality.passed) {
        logger.debug('Payload quality gate passed', {
            conversationId,
            platform: platformName,
            model: quality.model,
            reasoningCount: quality.reasoningCount,
        });
        return quality;
    }

    const diagnostic = buildQualityDiagnostic(conversationId, platformName, eventType, quality, captureMeta, data);

    logger.warn('⚠ Payload quality gate FAILED', {
        conversationId,
        platform: platformName,
        issues: quality.issues,
        model: quality.model ?? '(missing)',
        reasoningCount: quality.reasoningCount,
        captureSource: captureMeta.captureSource,
        fidelity: captureMeta.fidelity,
        defaultModelSlug: diagnostic.modelHints.defaultModelSlug ?? '(none)',
        mappingModelSlugs: diagnostic.modelHints.mappingModelSlugs,
    });

    logger.info('Payload quality diagnostic snapshot', diagnostic);

    return quality;
};
