import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import { V3_STREAM_DEBUG_MESSAGE_TYPES } from '@/features/runtime/v3-stream-debug-bridge';
import { setupStreamDebugBridge } from '@/features/stream-debug/bridge';
import { createStreamDebugRecorder } from '@/features/stream-debug/recorder';
import { getSessionToken, setSessionToken } from '@/utils/protocol/session-token';

describe('MAIN-world stream-debug bridge', () => {
    let windowInstance: Window | undefined;
    let previousWindow: unknown;

    beforeEach(() => {
        previousWindow = (globalThis as Record<string, unknown>).window;
        windowInstance = new Window();
        (globalThis as any).window = windowInstance;
    });

    afterEach(() => {
        windowInstance = undefined;
        const globalRecord = globalThis as Record<string, unknown>;
        if (previousWindow === undefined) {
            delete globalRecord.window;
        } else {
            globalRecord.window = previousWindow;
        }
    });

    it('should transfer records only for an explicit token-valid export request', async () => {
        if (!windowInstance) {
            throw new Error('No windowInstance');
        }
        setSessionToken('bk:stream-debug-bridge');
        const recorder = createStreamDebugRecorder();
        const streamId = recorder.startStream({
            streamId: 'stream-bridge-1',
            platform: 'ChatGPT',
            endpoint: 'generation',
            method: 'POST',
            url: '/stream',
        });
        recorder.appendFrame(streamId, 'private frame', { kind: 'raw_chunk' });
        setupStreamDebugBridge({ window: windowInstance as never, recorder });

        const response = new Promise<Record<string, unknown>>((resolve) => {
            windowInstance?.addEventListener('message', (event: any) => {
                const message = event.data as Record<string, unknown>;
                if (message.type === V3_STREAM_DEBUG_MESSAGE_TYPES.EXPORT_RESPONSE) {
                    resolve(message);
                }
            });
        });
        windowInstance.postMessage(
            {
                type: V3_STREAM_DEBUG_MESSAGE_TYPES.EXPORT_REQUEST,
                requestId: 'export-1',
                __blackiyaToken: getSessionToken(),
            },
            windowInstance.location.origin,
        );

        await expect(response).resolves.toMatchObject({
            type: V3_STREAM_DEBUG_MESSAGE_TYPES.EXPORT_RESPONSE,
            requestId: 'export-1',
            ok: true,
            records: [{ streamId: 'stream-bridge-1' }],
        });
    });

    it('should ignore mismatched tokens and clear only after an explicit valid request', async () => {
        if (!windowInstance) {
            throw new Error('No windowInstance');
        }
        setSessionToken('bk:stream-debug-bridge-2');
        const recorder = createStreamDebugRecorder();
        const streamId = recorder.startStream({
            streamId: 'stream-bridge-2',
            platform: 'Grok',
            endpoint: 'generation',
            method: 'POST',
            url: '/stream',
        });
        recorder.appendFrame(streamId, 'frame', { kind: 'raw_chunk' });
        setupStreamDebugBridge({ window: windowInstance as never, recorder });

        let responses = 0;
        windowInstance.addEventListener('message', (event: any) => {
            if ((event.data as Record<string, unknown>).type === V3_STREAM_DEBUG_MESSAGE_TYPES.EXPORT_RESPONSE) {
                responses += 1;
            }
        });
        windowInstance.postMessage(
            {
                type: V3_STREAM_DEBUG_MESSAGE_TYPES.EXPORT_REQUEST,
                requestId: 'wrong-token',
                __blackiyaToken: 'bk:wrong',
            },
            windowInstance.location.origin,
        );

        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(responses).toBe(0);

        windowInstance.postMessage(
            {
                type: V3_STREAM_DEBUG_MESSAGE_TYPES.CLEAR_REQUEST,
                requestId: 'clear-1',
                __blackiyaToken: getSessionToken(),
            },
            windowInstance.location.origin,
        );

        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(recorder.exportRecords()).toHaveLength(0);
    });
});
