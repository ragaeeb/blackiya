import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import { setupMainWorldBridge, shouldApplySessionInitToken } from '@/entrypoints/interceptor/bootstrap-main-bridge';
import {
    maybeCaptureGeminiBatchexecuteContext,
    resetGeminiBatchexecuteContext,
} from '@/entrypoints/interceptor/gemini-batchexecute-context-store';
import { platformHeaderStore } from '@/utils/platform-header-store';
import { getSessionToken, setSessionToken } from '@/utils/protocol/session-token';
import { streamDebugRecorder } from '@/features/stream-debug/recorder';
import { MAIN_WORLD_COMMAND_MESSAGE, MAIN_WORLD_RESULT_MESSAGE } from '@/features/runtime/main-world-command-contract';

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
        streamDebugRecorder.clear();
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
        setupMainWorldBridge();

        expect((windowInstance as any).__blackiya).toBeUndefined();
    });

    it('should not expose captured platform headers through page messages', async () => {
        setupMainWorldBridge();

        platformHeaderStore.update('ChatGPT', {
            authorization: 'Bearer test',
            'oai-device-id': 'device-1',
        });

        let responseCount = 0;
        windowInstance.addEventListener('message', ((event: MessageEvent) => {
            if ((event.data as Record<string, unknown>).type === 'BLACKIYA_PLATFORM_HEADERS_RESPONSE') {
                responseCount += 1;
            }
        }) as any);
        windowInstance.postMessage(
            {
                type: 'BLACKIYA_PLATFORM_HEADERS_REQUEST',
                requestId: 'request-1',
                platformName: 'ChatGPT',
                __blackiyaToken: getSessionToken(),
            },
            windowInstance.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(responseCount).toBe(0);
    });

    it('should not expose Gemini batchexecute context through page messages', async () => {
        maybeCaptureGeminiBatchexecuteContext(
            'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&bl=boq&f.sid=123&hl=en&_reqid=42&rt=c',
            'f.req=%5B%5D&at=AJvToken%3A1&',
        );

        setupMainWorldBridge();

        let responseCount = 0;
        windowInstance.addEventListener('message', ((event: MessageEvent) => {
            if ((event.data as Record<string, unknown>).type === 'BLACKIYA_GEMINI_BATCHEXECUTE_CONTEXT_RESPONSE') {
                responseCount += 1;
            }
        }) as any);
        windowInstance.postMessage(
            {
                type: 'BLACKIYA_GEMINI_BATCHEXECUTE_CONTEXT_REQUEST',
                requestId: 'gemini-context-1',
                __blackiyaToken: getSessionToken(),
            },
            windowInstance.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(responseCount).toBe(0);
    });

    it('should clear stream-debug records in MAIN and return only a count summary', async () => {
        const streamId = streamDebugRecorder.startStream({
            streamId: 'main-clear-1',
            platform: 'ChatGPT',
            endpoint: 'generation',
            method: 'POST',
            url: '/stream',
        });
        streamDebugRecorder.appendFrame(streamId, 'private frame', { kind: 'raw_chunk' });
        setupMainWorldBridge();

        const response = new Promise<Record<string, unknown>>((resolve) => {
            windowInstance.addEventListener('message', ((event: MessageEvent) => {
                if ((event.data as Record<string, unknown>).type === MAIN_WORLD_RESULT_MESSAGE) {
                    resolve(event.data as Record<string, unknown>);
                }
            }) as any);
        });
        windowInstance.postMessage(
            {
                type: MAIN_WORLD_COMMAND_MESSAGE,
                operation: 'stream_debug_clear',
                requestId: 'clear-main-1',
                __blackiyaToken: getSessionToken(),
            },
            windowInstance.location.origin,
        );

        await expect(response).resolves.toMatchObject({
            type: MAIN_WORLD_RESULT_MESSAGE,
            operation: 'stream_debug_clear',
            ok: true,
            result: { operation: 'stream_debug_clear', clearedStreams: 1 },
        });
        expect(streamDebugRecorder.exportRecords()).toHaveLength(0);
    });

});
