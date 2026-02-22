import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import { buildLoggerMock, createLoggerCalls } from '@/utils/runner/__tests__/helpers';
import {
    handleConversationIdResolvedMessage,
    handleLifecycleMessage,
    handleResponseFinishedMessage,
    handleTitleResolvedMessage,
    type WireMessageHandlerDeps,
} from '@/utils/runner/wire-message-handlers';

const logCalls = createLoggerCalls();
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));

describe('wire-message-handlers', () => {
    let deps: WireMessageHandlerDeps;

    beforeEach(() => {
        logCalls.debug.length = 0;
        logCalls.info.length = 0;
        logCalls.warn.length = 0;
        logCalls.error.length = 0;

        deps = {
            getAdapter: mock(
                () => ({ name: 'ChatGPT', defaultTitles: ['New chat'], extractConversationId: () => 'c-1' }) as any,
            ),
            getCurrentConversationId: mock(() => 'c-1'),
            getActiveAttemptId: mock(() => 'a-1'),
            resolveAliasedAttemptId: mock((id) => id),
            isStaleAttemptMessage: mock(() => false),
            forwardAttemptAlias: mock(() => {}),
            setActiveAttempt: mock(() => {}),
            setCurrentConversation: mock(() => {}),
            bindAttempt: mock(() => {}),
            getLifecycleState: mock(() => 'streaming' as any),
            setLifecycleState: mock(() => {}),
            setLifecycleAttemptId: mock(() => {}),
            setLifecycleConversationId: mock(() => {}),
            isPlatformGenerating: mock(() => false),
            streamResolvedTitles: new Map(),
            maxStreamResolvedTitles: 10,
            getConversation: mock(() => ({ title: 'cached' }) as any),
            cachePendingLifecycleSignal: mock(() => {}),
            ingestSfeLifecycleFromWirePhase: mock(() => {}),
            applyLifecyclePhaseForConversation: mock(() => {}),
            handleResponseFinished: mock(() => {}),
            appendPendingStreamProbeText: mock(() => {}),
            appendLiveStreamProbeText: mock(() => {}),
            isStreamDumpEnabled: mock(() => true),
            saveStreamDumpFrame: mock(() => {}),
            pendingLifecycleByAttempt: new Map(),
            sfeUpdateConversationId: mock(() => {}),
            refreshButtonState: mock(() => {}),
            cancelStreamDoneProbe: mock(() => {}),
            clearCanonicalStabilizationRetry: mock(() => {}),
            sfeDispose: mock(() => {}),
            streamPreviewState: { liveByAttemptWithoutConversation: new Map(), liveByConversation: new Map() } as any,
            attemptByConversation: new Map(),
            shouldRemoveDisposedAttemptBinding: mock(() => true),
        };

        if (!(globalThis as any).window) {
            (globalThis as any).window = {};
        }
        if (!(globalThis as any).window.location) {
            (globalThis as any).window.location = {};
        }
        (globalThis as any).window.location.origin = 'http://localhost';
    });

    describe('handleTitleResolvedMessage', () => {
        it('should return false if wrong type', () => {
            expect(handleTitleResolvedMessage({ type: 'BAD' }, deps)).toBeFalse();
        });

        it('should resolve title and update deps map and conversation fallback', () => {
            const msg = { type: MESSAGE_TYPES.TITLE_RESOLVED, conversationId: 'c-1', title: 'New Title' };
            expect(handleTitleResolvedMessage(msg, deps)).toBeTrue();
            expect(deps.streamResolvedTitles.get('c-1')).toBe('New Title');
        });
    });

    describe('handleResponseFinishedMessage', () => {
        it('should promote lifecycle and delegate finishes', () => {
            const msg = {
                type: MESSAGE_TYPES.RESPONSE_FINISHED,
                attemptId: 'a-1',
                platform: 'ChatGPT',
                conversationId: 'c-1',
            };
            expect(handleResponseFinishedMessage(msg, deps)).toBeTrue();
            expect(deps.setLifecycleState).toHaveBeenCalledWith('completed', 'c-1');
            expect(deps.handleResponseFinished).toHaveBeenCalledWith('network', 'c-1');
        });

        it('should reject if platform still generating for chatgpt', () => {
            deps.isPlatformGenerating = mock(() => true);
            const msg = {
                type: MESSAGE_TYPES.RESPONSE_FINISHED,
                attemptId: 'a-1',
                platform: 'ChatGPT',
                conversationId: 'c-1',
            };
            expect(handleResponseFinishedMessage(msg, deps)).toBeTrue();
            expect(deps.setLifecycleState).not.toHaveBeenCalled();
            expect(deps.handleResponseFinished).not.toHaveBeenCalled();
        });
    });

    describe('handleLifecycleMessage', () => {
        it('should trigger pending cache if no conversation id', () => {
            const msg = {
                type: MESSAGE_TYPES.RESPONSE_LIFECYCLE,
                attemptId: 'a-1',
                platform: 'ChatGPT',
                phase: 'prompt-sent',
            };
            expect(handleLifecycleMessage(msg, deps)).toBeTrue();
            expect(deps.cachePendingLifecycleSignal).toHaveBeenCalledWith('a-1', 'prompt-sent', 'ChatGPT');
        });

        it('should bind and apply if id is present', () => {
            const msg = {
                type: MESSAGE_TYPES.RESPONSE_LIFECYCLE,
                attemptId: 'a-1',
                platform: 'ChatGPT',
                phase: 'streaming',
                conversationId: 'c-1',
            };
            expect(handleLifecycleMessage(msg, deps)).toBeTrue();
            expect(deps.applyLifecyclePhaseForConversation).toHaveBeenCalledWith(
                'streaming',
                'ChatGPT',
                'a-1',
                'c-1',
                'direct',
            );
        });
    });

    describe('handleConversationIdResolvedMessage', () => {
        it('should dispatch pending signals', () => {
            deps.pendingLifecycleByAttempt.set('a-1', { phase: 'streaming', platform: 'ChatGPT', receivedAtMs: 1 });
            const msg = { type: MESSAGE_TYPES.CONVERSATION_ID_RESOLVED, attemptId: 'a-1', conversationId: 'c-1' };

            expect(handleConversationIdResolvedMessage(msg, deps)).toBeTrue();
            expect(deps.sfeUpdateConversationId).toHaveBeenCalledWith('a-1', 'c-1');
            expect(deps.applyLifecyclePhaseForConversation).toHaveBeenCalledWith(
                'streaming',
                'ChatGPT',
                'a-1',
                'c-1',
                'replayed',
            );
        });
    });

});
