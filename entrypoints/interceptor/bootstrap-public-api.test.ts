import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import { setupPublicWindowApi } from '@/entrypoints/interceptor/bootstrap-public-api';
import {
    BLACKIYA_PUBLIC_API_VERSION,
    BLACKIYA_WAIT_FOR_READY_TIMEOUT_MS,
} from '@/entrypoints/interceptor/public-api-contract';
import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import { setSessionToken, stampToken } from '@/utils/protocol/session-token';

describe('bootstrap-public-api', () => {
    let windowInstance: Window;
    let originalWindow: unknown;

    beforeEach(() => {
        windowInstance = new Window();
        originalWindow = (globalThis as any).window;
        (globalThis as any).window = windowInstance;
        setSessionToken('bk:test-public-api');
    });

    afterEach(() => {
        (globalThis as any).window = originalWindow;
    });

    const setupApi = () => {
        setupPublicWindowApi({
            getRawCaptureHistory: () => [],
            cleanupDisposedAttempt: () => {},
            setStreamDumpEnabled: () => {},
            clearStreamDumpCaches: () => {},
        });
        return (windowInstance as unknown as { __blackiya?: any }).__blackiya;
    };

    it('should expose version and waitForReady on window.__blackiya', () => {
        const api = setupApi();
        expect(api).toBeDefined();
        expect(api.version).toBe(BLACKIYA_PUBLIC_API_VERSION);
        expect(typeof api.waitForReady).toBe('function');
    });

    it('should resolve waitForReady when a ready status is received', async () => {
        const api = setupApi();
        const waitPromise = api.waitForReady({ timeoutMs: 100, emitCurrent: false });

        const readyMessage = stampToken({
            type: MESSAGE_TYPES.PUBLIC_STATUS,
            status: {
                platform: 'ChatGPT',
                conversationId: 'conv-1',
                attemptId: 'attempt-1',
                lifecycle: 'completed',
                readiness: 'canonical_ready',
                readinessReason: 'ready',
                canGetJSON: true,
                canGetCommonJSON: true,
                sequence: 1,
                timestampMs: Date.now(),
            },
        });
        windowInstance.postMessage(readyMessage, windowInstance.location.origin);

        const status = await waitPromise;
        expect(status.conversationId).toBe('conv-1');
        expect(status.readiness).toBe('canonical_ready');
    });

    it('should reject waitForReady on timeout', async () => {
        const api = setupApi();
        await expect(api.waitForReady({ timeoutMs: 10, emitCurrent: false })).rejects.toThrow('waitForReady timed out');
    });

    it('should default waitForReady timeout when options are not provided', () => {
        expect(BLACKIYA_WAIT_FOR_READY_TIMEOUT_MS).toBe(15_000);
    });
});
