import { describe, expect, it } from 'bun:test';
import { type ResolveRunnerReadinessInput, resolveRunnerReadinessDecision } from '@/utils/runner/readiness';
import type { ConversationData } from '@/utils/types';

const createInput = (overrides: Partial<ResolveRunnerReadinessInput> = {}): ResolveRunnerReadinessInput => {
    const data = {
        conversation_id: 'conv-1',
        title: 'Title',
        create_time: 0,
        update_time: 0,
        current_node: 'node-1',
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: null,
        safe_urls: [],
        blocked_urls: [],
        mapping: {},
    } as unknown as ConversationData;

    return {
        conversationId: 'conv-1',
        data,
        sfeEnabled: true,
        captureMeta: {
            captureSource: 'canonical_api',
            fidelity: 'high',
            completeness: 'complete',
        },
        sfeResolution: {
            ready: true,
            reason: 'canonical_ready',
            blockingConditions: [],
        },
        evaluateReadinessForData: () => ({
            ready: true,
            terminal: true,
            reason: 'terminal',
            contentHash: 'hash',
            latestAssistantTextLength: 12,
        }),
        resolveAttemptId: () => 'attempt-1',
        hasCanonicalStabilizationTimedOut: () => false,
        emitTimeoutWarningOnce: () => {},
        clearTimeoutWarningByAttempt: () => {},
        logSfeMismatchIfNeeded: () => {},
        shouldLogCanonicalReadyDecision: () => true,
        clearCanonicalReadyLogStamp: () => {},
        ...overrides,
    };
};

describe('runner readiness resolver', () => {
    it('returns missing-data readiness when no conversation data is available', () => {
        let cleared = false;
        const decision = resolveRunnerReadinessDecision(
            createInput({
                data: null,
                clearCanonicalReadyLogStamp: () => {
                    cleared = true;
                },
            }),
        );
        expect(decision).toEqual({
            ready: false,
            mode: 'awaiting_stabilization',
            reason: 'no_canonical_data',
        });
        expect(cleared).toBeTrue();
    });

    it('returns canonical_ready when SFE and legacy readiness are both ready at high fidelity', () => {
        const decision = resolveRunnerReadinessDecision(createInput());
        expect(decision).toEqual({
            ready: true,
            mode: 'canonical_ready',
            reason: 'canonical_ready',
        });
    });

    it('returns degraded_manual_only when stabilization timeout is detected', () => {
        let warned = false;
        const decision = resolveRunnerReadinessDecision(
            createInput({
                captureMeta: {
                    captureSource: 'dom_snapshot_degraded',
                    fidelity: 'degraded',
                    completeness: 'partial',
                },
                sfeResolution: {
                    ready: false,
                    reason: 'awaiting_second_sample',
                    blockingConditions: ['stabilization_timeout'],
                },
                evaluateReadinessForData: () => ({
                    ready: false,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: 'hash',
                    latestAssistantTextLength: 10,
                }),
                emitTimeoutWarningOnce: () => {
                    warned = true;
                },
            }),
        );
        expect(decision).toEqual({
            ready: false,
            mode: 'degraded_manual_only',
            reason: 'stabilization_timeout',
        });
        expect(warned).toBeTrue();
    });

    it('falls back to awaiting stabilization with SFE reason when canonical capture is not ready', () => {
        const decision = resolveRunnerReadinessDecision(
            createInput({
                sfeResolution: {
                    ready: false,
                    reason: 'awaiting_second_sample',
                    blockingConditions: [],
                },
                evaluateReadinessForData: () => ({
                    ready: false,
                    terminal: true,
                    reason: 'legacy_not_ready',
                    contentHash: null,
                    latestAssistantTextLength: 0,
                }),
            }),
        );
        expect(decision).toEqual({
            ready: false,
            mode: 'awaiting_stabilization',
            reason: 'awaiting_second_sample',
        });
    });

    it('resolves attemptId once when evaluating timeout-ready fallback paths', () => {
        let resolveAttemptIdCalls = 0;
        let clearedAttemptId = '';
        const decision = resolveRunnerReadinessDecision(
            createInput({
                sfeResolution: {
                    ready: false,
                    reason: 'awaiting_second_sample',
                    blockingConditions: [],
                },
                captureMeta: {
                    captureSource: 'canonical_api',
                    fidelity: 'high',
                    completeness: 'complete',
                },
                evaluateReadinessForData: () => ({
                    ready: false,
                    terminal: true,
                    reason: 'legacy_not_ready',
                    contentHash: null,
                    latestAssistantTextLength: 0,
                }),
                resolveAttemptId: () => {
                    resolveAttemptIdCalls += 1;
                    return 'attempt-single-call';
                },
                clearTimeoutWarningByAttempt: (attemptId) => {
                    clearedAttemptId = attemptId;
                },
            }),
        );
        expect(decision).toEqual({
            ready: false,
            mode: 'awaiting_stabilization',
            reason: 'awaiting_second_sample',
        });
        expect(resolveAttemptIdCalls).toBe(1);
        expect(clearedAttemptId).toBe('attempt-single-call');
    });
});
