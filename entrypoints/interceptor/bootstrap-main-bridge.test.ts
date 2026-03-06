import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { setupMainWorldBridge, shouldApplySessionInitToken } from '@/entrypoints/interceptor/bootstrap-main-bridge';
import {
    maybeCaptureGeminiBatchexecuteContext,
    resetGeminiBatchexecuteContext,
} from '@/entrypoints/interceptor/gemini-batchexecute-context-store';
import {
    GEMINI_BATCHEXECUTE_CONTEXT_REQUEST_MESSAGE,
    GEMINI_BATCHEXECUTE_CONTEXT_RESPONSE_MESSAGE,
} from '@/utils/gemini-batchexecute-bridge';
import { PLATFORM_HEADERS_REQUEST_MESSAGE, PLATFORM_HEADERS_RESPONSE_MESSAGE } from '@/utils/platform-header-bridge';
import { platformHeaderStore } from '@/utils/platform-header-store';
import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import { getSessionToken, setSessionToken } from '@/utils/protocol/session-token';

describe('bootstrap-main-bridge', () => {
    let windowInstance: Window;
    let originalWindow: unknown;

    beforeEach(() => {
        windowInstance = new Window();
        originalWindow = (globalThis as any).window;
        (globalThis as any).window = windowInstance;
        setSessionToken('bk:test-main-bridge');
        platformHeaderStore.clear();
        resetGeminiBatchexecuteContext();
    });

    afterEach(() => {
        (globalThis as any).window = originalWindow;
    });

    it('should apply session init token only once', () => {
        expect(shouldApplySessionInitToken(undefined, 'bk:first')).toBeTrue();
        expect(shouldApplySessionInitToken('bk:first', 'bk:second')).toBeFalse();
        expect(shouldApplySessionInitToken('', 'bk:first')).toBeTrue();
        expect(shouldApplySessionInitToken(undefined, '')).toBeFalse();
    });

    it('should not expose window.__blackiya', () => {
        setupMainWorldBridge({
            getRawCaptureHistory: () => [],
            cleanupDisposedAttempt: () => {},
        });

        expect((windowInstance as any).__blackiya).toBeUndefined();
    });

    it('should process ATTEMPT_DISPOSED for matching session token', () => {
        const cleanupDisposedAttempt = mock(() => {});
        setupMainWorldBridge({
            getRawCaptureHistory: () => [],
            cleanupDisposedAttempt,
        });

        windowInstance.postMessage(
            {
                type: MESSAGE_TYPES.ATTEMPT_DISPOSED,
                attemptId: 'attempt-1',
                __blackiyaToken: getSessionToken(),
            },
            windowInstance.location.origin,
        );
        return new Promise<void>((resolve) => {
            windowInstance.setTimeout(() => {
                expect(cleanupDisposedAttempt).toHaveBeenCalledWith('attempt-1');
                resolve();
            }, 0);
        });
    });

    it('should ignore ATTEMPT_DISPOSED when session token is mismatched', () => {
        const cleanupDisposedAttempt = mock(() => {});
        setupMainWorldBridge({
            getRawCaptureHistory: () => [],
            cleanupDisposedAttempt,
        });

        windowInstance.postMessage(
            {
                type: MESSAGE_TYPES.ATTEMPT_DISPOSED,
                attemptId: 'attempt-1',
                __blackiyaToken: 'bk:wrong-token',
            },
            windowInstance.location.origin,
        );
        return new Promise<void>((resolve) => {
            windowInstance.setTimeout(() => {
                expect(cleanupDisposedAttempt).not.toHaveBeenCalled();
                resolve();
            }, 0);
        });
    });

    it('should respond to platform headers requests with captured headers', () => {
        setupMainWorldBridge({
            getRawCaptureHistory: () => [],
            cleanupDisposedAttempt: () => {},
        });

        platformHeaderStore.update('ChatGPT', {
            authorization: 'Bearer test',
            'oai-device-id': 'device-1',
        });

        return new Promise<void>((resolve) => {
            const requestId = 'request-1';
            const onMessage = (event: MessageEvent) => {
                const message = event.data as Record<string, unknown> | null;
                if (
                    message?.type !== PLATFORM_HEADERS_RESPONSE_MESSAGE ||
                    message.requestId !== requestId ||
                    message.platformName !== 'ChatGPT'
                ) {
                    return;
                }
                windowInstance.removeEventListener('message', onMessage as any);
                const headers = message.headers as Record<string, string> | undefined;
                expect(headers?.authorization).toBe('Bearer test');
                expect(headers?.['oai-device-id']).toBe('device-1');
                resolve();
            };

            windowInstance.addEventListener('message', onMessage as any);
            windowInstance.postMessage(
                {
                    type: PLATFORM_HEADERS_REQUEST_MESSAGE,
                    requestId,
                    platformName: 'ChatGPT',
                    __blackiyaToken: getSessionToken(),
                },
                windowInstance.location.origin,
            );
        });
    });

    it('should respond to gemini batchexecute context requests', () => {
        maybeCaptureGeminiBatchexecuteContext(
            'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&bl=boq&f.sid=123&hl=en&_reqid=42&rt=c',
            'f.req=%5B%5D&at=AJvToken%3A1&',
        );

        setupMainWorldBridge({
            getRawCaptureHistory: () => [],
            cleanupDisposedAttempt: () => {},
        });

        return new Promise<void>((resolve) => {
            const requestId = 'gemini-context-1';
            const onMessage = (event: MessageEvent) => {
                const message = event.data as Record<string, unknown> | null;
                if (message?.type !== GEMINI_BATCHEXECUTE_CONTEXT_RESPONSE_MESSAGE || message.requestId !== requestId) {
                    return;
                }
                windowInstance.removeEventListener('message', onMessage as any);
                const context = message.context as Record<string, unknown> | undefined;
                expect(context?.bl).toBe('boq');
                expect(context?.fSid).toBe('123');
                expect(context?.at).toBe('AJvToken:1');
                resolve();
            };

            windowInstance.addEventListener('message', onMessage as any);
            windowInstance.postMessage(
                {
                    type: GEMINI_BATCHEXECUTE_CONTEXT_REQUEST_MESSAGE,
                    requestId,
                    __blackiyaToken: getSessionToken(),
                },
                windowInstance.location.origin,
            );
        });
    });
});
