import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { setupMainWorldBridge, shouldApplySessionInitToken } from '@/entrypoints/interceptor/bootstrap-main-bridge';
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
            setStreamDumpEnabled: () => {},
            clearStreamDumpCaches: () => {},
        });

        expect((windowInstance as any).__blackiya).toBeUndefined();
    });

    it('should process ATTEMPT_DISPOSED for matching session token', () => {
        const cleanupDisposedAttempt = mock(() => {});
        setupMainWorldBridge({
            getRawCaptureHistory: () => [],
            cleanupDisposedAttempt,
            setStreamDumpEnabled: () => {},
            clearStreamDumpCaches: () => {},
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
            setStreamDumpEnabled: () => {},
            clearStreamDumpCaches: () => {},
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

    it('should update stream dump state and clear caches when disabled', () => {
        const setStreamDumpEnabled = mock(() => {});
        const clearStreamDumpCaches = mock(() => {});
        setupMainWorldBridge({
            getRawCaptureHistory: () => [],
            cleanupDisposedAttempt: () => {},
            setStreamDumpEnabled,
            clearStreamDumpCaches,
        });

        windowInstance.postMessage(
            {
                type: MESSAGE_TYPES.STREAM_DUMP_CONFIG,
                enabled: true,
                __blackiyaToken: getSessionToken(),
            },
            windowInstance.location.origin,
        );
        windowInstance.postMessage(
            {
                type: MESSAGE_TYPES.STREAM_DUMP_CONFIG,
                enabled: false,
                __blackiyaToken: getSessionToken(),
            },
            windowInstance.location.origin,
        );
        return new Promise<void>((resolve) => {
            windowInstance.setTimeout(() => {
                expect(setStreamDumpEnabled).toHaveBeenCalledTimes(2);
                expect(clearStreamDumpCaches).toHaveBeenCalledTimes(1);
                resolve();
            }, 0);
        });
    });
});
