import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { emitPublicStatusSnapshot, type PublicStatusDeps, type PublicStatusState } from '@/utils/runner/public-status';

describe('public-status', () => {
    let deps: PublicStatusDeps;
    let originalWindow: any;
    let mockPostMessage: ReturnType<typeof mock>;

    beforeEach(() => {
        originalWindow = (globalThis as any).window;
        mockPostMessage = mock(() => {});
        (globalThis as any).window = {
            postMessage: mockPostMessage,
            location: { origin: 'test' },
        };

        deps = {
            getCurrentConversationId: mock(() => 'conv-1'),
            resolveLocationConversationId: mock(() => null),
            peekAttemptId: mock(() => 'attempt-1'),
            getActiveAttemptId: mock(() => null),
            getAdapterName: mock(() => 'ChatGPT'),
            getLifecycleState: mock(() => 'completed' as any),
            resolveReadinessDecision: mock(() => ({ mode: 'canonical_ready', reason: null, ready: true }) as any),
            shouldBlockActionsForGeneration: mock(() => false),
            hasAdapter: mock(() => true),
        };
    });

    afterEach(() => {
        (globalThis as any).window = originalWindow;
    });

    it('should ignore duplicate signatures', () => {
        const state: PublicStatusState = { sequence: 1, lastSignature: '' };

        emitPublicStatusSnapshot(undefined, state, deps);
        expect(mockPostMessage).toHaveBeenCalledTimes(1);

        const lastSignature = state.lastSignature;
        expect(lastSignature).not.toBe('');

        emitPublicStatusSnapshot(undefined, state, deps);
        expect(mockPostMessage).toHaveBeenCalledTimes(1); // did not change
    });

    it('should calculate canGet based on readiness and block conditions', () => {
        const state: PublicStatusState = { sequence: 1, lastSignature: '' };
        emitPublicStatusSnapshot(undefined, state, deps);

        expect(mockPostMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                status: expect.objectContaining({
                    canGetJSON: true,
                }),
            }),
            'test',
        );

        deps.shouldBlockActionsForGeneration = mock(() => true);
        const state2: PublicStatusState = { sequence: 1, lastSignature: '' };
        emitPublicStatusSnapshot(undefined, state2, deps);

        expect(mockPostMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                status: expect.objectContaining({
                    canGetJSON: false,
                }),
            }),
            'test',
        );
    });

    it('should use conversationId override if provided', () => {
        const state: PublicStatusState = { sequence: 1, lastSignature: '' };
        emitPublicStatusSnapshot('override-id', state, deps);

        expect(mockPostMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                status: expect.objectContaining({
                    conversationId: 'override-id',
                }),
            }),
            'test',
        );
    });

    it('should fallback to resolveLocationConversationId if current is null', () => {
        const state: PublicStatusState = { sequence: 1, lastSignature: '' };
        deps.getCurrentConversationId = () => null;
        deps.resolveLocationConversationId = () => 'loc-id';

        emitPublicStatusSnapshot(undefined, state, deps);

        expect(mockPostMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                status: expect.objectContaining({
                    conversationId: 'loc-id',
                }),
            }),
            'test',
        );
    });
});
