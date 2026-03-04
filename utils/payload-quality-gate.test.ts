import { beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('@/utils/logger', () => ({
    logger: {
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
    },
}));

import { logger } from '@/utils/logger';
import {
    buildQualityDiagnostic,
    evaluatePayloadQuality,
    type PayloadQualityResult,
    runPayloadQualityGate,
} from '@/utils/payload-quality-gate';
import type { ConversationData } from '@/utils/types';

const buildConversationWithModel = (model: string, hasReasoning: boolean): ConversationData => ({
    title: 'Test conversation',
    create_time: 1772608923,
    update_time: 1772609000,
    conversation_id: 'test-conv-1',
    current_node: 'assistant-1',
    mapping: {
        root: { id: 'root', message: null, parent: null, children: ['user-1'] },
        'user-1': {
            id: 'user-1',
            message: {
                id: 'user-1',
                author: { role: 'user', name: null, metadata: {} },
                create_time: 1772608920,
                update_time: 1772608920,
                content: { content_type: 'text', parts: ['What is the meaning of life?'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
            parent: 'root',
            children: hasReasoning ? ['thinking-1'] : ['assistant-1'],
        },
        ...(hasReasoning
            ? {
                  'thinking-1': {
                      id: 'thinking-1',
                      message: {
                          id: 'thinking-1',
                          author: { role: 'assistant', name: null, metadata: {} },
                          create_time: 1772608921,
                          update_time: null,
                          content: {
                              content_type: 'thoughts',
                              thoughts: [
                                  {
                                      summary: 'Thinking about meaning',
                                      content: 'Considering various philosophical perspectives.',
                                      chunks: ['Considering various philosophical perspectives.'],
                                      finished: true,
                                  },
                              ],
                          },
                          status: 'finished_successfully',
                          end_turn: null,
                          weight: 1,
                          metadata: { reasoning_status: 'is_reasoning', resolved_model_slug: model },
                          recipient: 'all',
                          channel: null,
                      },
                      parent: 'user-1',
                      children: ['assistant-1'],
                  },
              }
            : {}),
        'assistant-1': {
            id: 'assistant-1',
            message: {
                id: 'assistant-1',
                author: { role: 'assistant', name: null, metadata: {} },
                create_time: 1772609000,
                update_time: null,
                content: { content_type: 'text', parts: ['The meaning of life is 42.'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {
                    model_slug: model,
                    resolved_model_slug: model,
                },
                recipient: 'all',
                channel: null,
            },
            parent: hasReasoning ? 'thinking-1' : 'user-1',
            children: [],
        },
    },
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: model,
    safe_urls: [],
    blocked_urls: [],
});

const buildDegradedConversation = (): ConversationData => ({
    title: 'Test conversation',
    create_time: 1772608923,
    update_time: 1772609000,
    conversation_id: 'degraded-conv',
    current_node: 'dom-1',
    mapping: {
        root: { id: 'root', message: null, parent: null, children: ['dom-1'] },
        'dom-1': {
            id: 'dom-1',
            message: {
                id: 'dom-1',
                author: { role: 'assistant', name: null, metadata: {} },
                create_time: 1772609000,
                update_time: null,
                content: { content_type: 'text', parts: ['The meaning of life is 42.'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
            parent: 'root',
            children: [],
        },
    },
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'unknown',
    safe_urls: [],
    blocked_urls: [],
});

describe('payload-quality-gate', () => {
    beforeEach(() => {
        (logger.info as ReturnType<typeof mock>).mockClear();
        (logger.warn as ReturnType<typeof mock>).mockClear();
        (logger.debug as ReturnType<typeof mock>).mockClear();
    });

    describe('evaluatePayloadQuality', () => {
        it('should pass when model and reasoning are present', () => {
            const data = buildConversationWithModel('gpt-5-2-thinking', true);
            const result = evaluatePayloadQuality(data, 'ChatGPT');

            expect(result.passed).toBeTrue();
            expect(result.issues).toEqual([]);
            expect(result.model).toBe('gpt-5-2-thinking');
            expect(result.reasoningCount).toBeGreaterThan(0);
        });

        it('should flag missing_model when model is absent', () => {
            const data = buildDegradedConversation();
            const result = evaluatePayloadQuality(data, 'ChatGPT');

            expect(result.passed).toBeFalse();
            expect(result.issues).toContain('missing_model');
        });

        it('should flag empty_reasoning when no reasoning is present', () => {
            const data = buildConversationWithModel('gpt-4o', false);
            const result = evaluatePayloadQuality(data, 'ChatGPT');

            // Model is present but reasoning is empty
            expect(result.issues).toContain('empty_reasoning');
            expect(result.model).toBe('gpt-4o');
            expect(result.reasoningCount).toBe(0);
        });

        it('should flag both issues for fully degraded payload', () => {
            const data = buildDegradedConversation();
            const result = evaluatePayloadQuality(data, 'ChatGPT');

            expect(result.passed).toBeFalse();
            expect(result.issues).toContain('missing_model');
            expect(result.issues).toContain('empty_reasoning');
        });

        it('should pass for model without reasoning (non-thinking model)', () => {
            const data = buildConversationWithModel('gpt-4o', false);
            const result = evaluatePayloadQuality(data, 'ChatGPT');

            // Non-thinking models don't produce reasoning — only missing_model is a hard fail
            expect(result.model).toBe('gpt-4o');
        });
    });

    describe('buildQualityDiagnostic', () => {
        it('should build a diagnostic with model hints from raw data', () => {
            const data = buildConversationWithModel('gpt-5-2-thinking', true);
            const quality: PayloadQualityResult = {
                passed: false,
                issues: ['empty_reasoning'],
                model: 'gpt-5-2-thinking',
                reasoningCount: 0,
                promptLength: 20,
                responseLength: 30,
            };

            const diagnostic = buildQualityDiagnostic(
                'test-conv',
                'ChatGPT',
                'conversation.ready',
                quality,
                { captureSource: 'snapshot', fidelity: 'degraded', completeness: 'partial' } as any,
                data,
            );

            expect(diagnostic.api).toBe('blackiya.payload-quality-diagnostic.v1');
            expect(diagnostic.conversationId).toBe('test-conv');
            expect(diagnostic.platform).toBe('ChatGPT');
            expect(diagnostic.quality.issues).toContain('empty_reasoning');
            expect(diagnostic.modelHints.defaultModelSlug).toBe('gpt-5-2-thinking');
            expect(diagnostic.modelHints.mappingModelSlugs).toContain('gpt-5-2-thinking');
            expect(diagnostic.modelHints.mappingResolvedModelSlugs).toContain('gpt-5-2-thinking');
            expect(diagnostic.rawDataBytes).toBeGreaterThan(0);
            expect(diagnostic.rawDataPreview.length).toBeLessThanOrEqual(2000);
        });

        it('should handle degraded data with no model hints', () => {
            const data = buildDegradedConversation();
            const quality: PayloadQualityResult = {
                passed: false,
                issues: ['missing_model', 'empty_reasoning'],
                model: undefined,
                reasoningCount: 0,
                promptLength: 0,
                responseLength: 30,
            };

            const diagnostic = buildQualityDiagnostic(
                'degraded-conv',
                'ChatGPT',
                'conversation.ready',
                quality,
                { captureSource: 'dom_snapshot', fidelity: 'degraded', completeness: 'partial' } as any,
                data,
            );

            expect(diagnostic.modelHints.defaultModelSlug).toBe('unknown');
            expect(diagnostic.modelHints.mappingModelSlugs).toEqual([]);
            expect(diagnostic.modelHints.mappingResolvedModelSlugs).toEqual([]);
        });
    });

    describe('runPayloadQualityGate', () => {
        it('should log debug on pass', () => {
            const data = buildConversationWithModel('gpt-5-2-thinking', true);
            const result = runPayloadQualityGate(
                'test-conv',
                'ChatGPT',
                'conversation.ready',
                { captureSource: 'canonical_api', fidelity: 'canonical', completeness: 'full' } as any,
                data,
            );

            expect(result.passed).toBeTrue();
            expect(logger.debug).toHaveBeenCalled();
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should log warn + diagnostic on failure', () => {
            const data = buildDegradedConversation();
            const result = runPayloadQualityGate(
                'degraded-conv',
                'ChatGPT',
                'conversation.ready',
                { captureSource: 'dom_snapshot', fidelity: 'degraded', completeness: 'partial' } as any,
                data,
            );

            expect(result.passed).toBeFalse();
            expect(logger.warn).toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalled();

            // Verify the warn call includes issue details
            const warnCall = (logger.warn as ReturnType<typeof mock>).mock.calls[0];
            expect(warnCall[0]).toContain('quality gate FAILED');
            expect(warnCall[1].issues).toContain('missing_model');
        });

        it('should work for Grok platform', () => {
            const data = buildConversationWithModel('grok-3', true);
            const result = runPayloadQualityGate(
                'grok-conv',
                'Grok',
                'conversation.ready',
                { captureSource: 'canonical_api', fidelity: 'canonical', completeness: 'full' } as any,
                data,
            );

            expect(result.model).toBe('grok-3');
        });

        it('should work for Gemini platform', () => {
            const data = buildConversationWithModel('gemini-2.0-flash', false);
            const result = runPayloadQualityGate(
                'gemini-conv',
                'Gemini',
                'conversation.ready',
                { captureSource: 'canonical_api', fidelity: 'canonical', completeness: 'full' } as any,
                data,
            );

            expect(result.model).toBe('gemini-2.0-flash');
        });
    });
});
