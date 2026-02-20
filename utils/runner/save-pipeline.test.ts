import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { buildLoggerMock, createLoggerCalls } from '@/utils/runner/__tests__/helpers';
import {
    applyTitleDomFallbackIfNeeded,
    getConversationData,
    recoverCanonicalBeforeForceSave,
    resolveSaveReadiness,
} from '@/utils/runner/save-pipeline';

const logCalls = createLoggerCalls();
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));

// Define global alert if not present
if (typeof globalThis.alert !== 'function') {
    (globalThis as any).alert = mock(() => {});
}

describe('save-pipeline', () => {
    let deps: any;

    beforeEach(() => {
        logCalls.debug.length = 0;
        logCalls.info.length = 0;
        logCalls.warn.length = 0;
        logCalls.error.length = 0;

        deps = {
            getAdapter: mock(() => ({ name: 'ChatGPT' }) as any),
            resolveConversationIdForUserAction: mock(() => 'conv-1'),
            getConversation: mock(() => ({ title: 'test', conversation_id: 'conv-1' }) as any),
            resolveReadinessDecision: mock(() => ({ mode: 'canonical_ready', reason: null }) as any),
            shouldBlockActionsForGeneration: mock(() => false),
            getCaptureMeta: mock(() => ({}) as any),
            getExportFormat: mock(() => Promise.resolve('common' as any)),
            getStreamResolvedTitle: mock(() => null),
            evaluateReadinessForData: mock(() => ({ ready: true }) as any),
            markCanonicalCaptureMeta: mock(() => {}),
            ingestSfeCanonicalSample: mock(() => {}),
            resolveAttemptId: mock(() => 'attempt-1'),
            peekAttemptId: mock(() => 'attempt-1'),
            refreshButtonState: mock(() => {}),
            requestPageSnapshot: mock(() => Promise.resolve(null)),
            warmFetchConversationSnapshot: mock(() => Promise.resolve(true)),
            ingestConversationData: mock(() => {}),
            isConversationDataLike: mock(() => true),
            buttonManagerExists: mock(() => true),
            buttonManagerSetLoading: mock(() => {}),
            buttonManagerSetSuccess: mock(() => {}),
            structuredLogger: { emit: mock(() => {}) } as any,
        };
    });

    describe('resolveSaveReadiness', () => {
        it('should return null if no conversation ID', () => {
            expect(resolveSaveReadiness(null, deps)).toBeNull();
        });

        it('should resolve readiness based on deps', () => {
            deps.resolveReadinessDecision.mockImplementationOnce(() => ({
                mode: 'degraded_manual_only',
                reason: 'timeout',
            }));
            const result = resolveSaveReadiness('conv-1', deps);
            expect(result).toEqual({
                conversationId: 'conv-1',
                decision: expect.objectContaining({ mode: 'degraded_manual_only', reason: 'timeout' }),
                allowDegraded: true,
            });
        });
    });

    describe('recoverCanonicalBeforeForceSave', () => {
        it('should return true if fresh snapshot makes it ready', async () => {
            deps.requestPageSnapshot.mockImplementationOnce(() => Promise.resolve({ convo: 1 }));
            deps.evaluateReadinessForData.mockImplementationOnce(() => ({ ready: true }));

            const recovered = await recoverCanonicalBeforeForceSave('conv-1', deps);

            expect(recovered).toBeTrue();
            expect(deps.ingestConversationData).toHaveBeenCalledWith({ convo: 1 }, 'force-save-snapshot-recovery');
            expect(deps.markCanonicalCaptureMeta).toHaveBeenCalledWith('conv-1');
            expect(deps.refreshButtonState).toHaveBeenCalledWith('conv-1');
        });

        it('should fetch warm snapshot and check decision if not recovered immediately', async () => {
            deps.isConversationDataLike.mockImplementationOnce(() => false);
            deps.resolveReadinessDecision.mockImplementationOnce(() => ({ mode: 'canonical_ready' }));

            const recovered = await recoverCanonicalBeforeForceSave('conv-1', deps);

            expect(recovered).toBeTrue();
            expect(deps.warmFetchConversationSnapshot).toHaveBeenCalledWith('conv-1', 'force-save');
            expect(deps.refreshButtonState).toHaveBeenCalledWith('conv-1');
        });
    });

    describe('getConversationData', () => {
        it('should resolve data if all checks pass', async () => {
            const data = await getConversationData({ silent: true }, deps);
            expect(data).toBeTruthy();
            expect(data!.conversation_id).toBe('conv-1');
        });

        it('should return null if still generating', async () => {
            deps.shouldBlockActionsForGeneration.mockImplementationOnce(() => true);
            const data = await getConversationData({ silent: true }, deps);
            expect(data).toBeNull();
            expect(logCalls.warn.length).toBe(1);
        });

        it('should return null if no conversation ID', async () => {
            deps.resolveConversationIdForUserAction.mockImplementationOnce(() => null);
            const data = await getConversationData({ silent: true }, deps);
            expect(data).toBeNull();
            expect(logCalls.error.length).toBe(1);
        });
    });

    describe('applyTitleDomFallbackIfNeeded', () => {
        it('should apply dom title if adapter supports it and stream resolved title is null', () => {
            const data: any = { conversation_id: 'conv-1', title: null, mapping: {} };
            deps.getAdapter.mockImplementationOnce(() => ({
                name: 'ChatGPT',
                extractTitleFromDom: () => 'DOM Title',
                defaultTitles: ['New chat'],
            }));

            applyTitleDomFallbackIfNeeded('conv-1', data, deps);
            expect(data.title).toBe('DOM Title');
        });

        it('should not override if stream resolved title exists', () => {
            const data: any = { conversation_id: 'conv-1', title: null, mapping: {} };
            deps.getAdapter.mockImplementationOnce(() => ({
                name: 'ChatGPT',
                extractTitleFromDom: () => 'DOM Title',
                defaultTitles: ['New chat'],
            }));
            deps.getStreamResolvedTitle.mockImplementationOnce(() => 'Stream Title');

            applyTitleDomFallbackIfNeeded('conv-1', data, deps);
            expect(data.title).toBe('Stream Title');
        });
    });
});
