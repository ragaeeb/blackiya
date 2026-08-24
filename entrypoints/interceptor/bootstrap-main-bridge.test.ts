import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import {
    isSameWindowOriginEvent,
    setupMainWorldBridge,
    shouldApplySessionInitToken,
} from '@/entrypoints/interceptor/bootstrap-main-bridge';
import {
    maybeCaptureGeminiBatchexecuteContext,
    resetGeminiBatchexecuteContext,
} from '@/entrypoints/interceptor/gemini-batchexecute-context-store';
import { MAIN_WORLD_COMMAND_MESSAGE, MAIN_WORLD_RESULT_MESSAGE } from '@/features/runtime/main-world-command-contract';
import { streamDebugRecorder } from '@/features/stream-debug/recorder';
import { platformHeaderStore } from '@/utils/platform-header-store';
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

    it('should require the exact MAIN-world window and origin for session init', () => {
        const pageWindow = { location: { origin: 'https://chatgpt.com' } };

        expect(
            isSameWindowOriginEvent({ source: pageWindow, origin: 'https://chatgpt.com' } as MessageEvent, pageWindow),
        ).toBeTrue();
        expect(
            isSameWindowOriginEvent(
                { source: undefined, origin: 'https://chatgpt.com' } as unknown as MessageEvent,
                pageWindow,
            ),
        ).toBeFalse();
        expect(
            isSameWindowOriginEvent({ source: null, origin: 'https://chatgpt.com' } as MessageEvent, pageWindow),
        ).toBeFalse();
        expect(
            isSameWindowOriginEvent({ source: pageWindow, origin: undefined } as unknown as MessageEvent, pageWindow),
        ).toBeFalse();
        expect(isSameWindowOriginEvent({ source: pageWindow, origin: 'null' } as MessageEvent, pageWindow)).toBeFalse();
        expect(
            isSameWindowOriginEvent({ source: {}, origin: 'https://chatgpt.com' } as MessageEvent, pageWindow),
        ).toBeFalse();
        expect(
            isSameWindowOriginEvent({ source: pageWindow, origin: 'https://evil.example' } as MessageEvent, pageWindow),
        ).toBeFalse();
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

    it('should reject a single-export command when MAIN has navigated to another conversation', async () => {
        windowInstance.location.href = 'https://chatgpt.com/c/conversation-b';
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
                operation: 'single_export',
                requestId: 'stale-single-command',
                target: { platform: 'ChatGPT', conversationId: 'conversation-a' },
                __blackiyaToken: getSessionToken(),
            },
            windowInstance.location.origin,
        );

        await expect(response).resolves.toMatchObject({
            type: MAIN_WORLD_RESULT_MESSAGE,
            operation: 'single_export',
            ok: false,
            error: 'Conversation changed before export started.',
            errorKind: 'conversation_changed',
        });
    });
});
