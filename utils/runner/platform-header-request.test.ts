import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import {
    PLATFORM_HEADERS_REQUEST_MESSAGE,
    PLATFORM_HEADERS_RESPONSE_MESSAGE,
    type PlatformHeadersRequestMessage,
} from '@/utils/platform-header-bridge';
import { getSessionToken, setSessionToken, stampToken } from '@/utils/protocol/session-token';
import { requestPlatformHeadersFromMainWorld } from '@/utils/runner/platform-header-request';

describe('platform-header-request', () => {
    let windowInstance: Window;
    let originalWindow: unknown;

    beforeEach(() => {
        windowInstance = new Window();
        originalWindow = (globalThis as any).window;
        (globalThis as any).window = windowInstance;
        setSessionToken('bk:test-header-request');
    });

    afterEach(() => {
        (globalThis as any).window = originalWindow;
    });

    it('should request and resolve headers from main world response', async () => {
        windowInstance.addEventListener('message', ((event: MessageEvent) => {
            const request = event.data as PlatformHeadersRequestMessage;
            if (request?.type !== PLATFORM_HEADERS_REQUEST_MESSAGE) {
                return;
            }
            windowInstance.postMessage(
                stampToken({
                    type: PLATFORM_HEADERS_RESPONSE_MESSAGE,
                    requestId: request.requestId,
                    platformName: request.platformName,
                    headers: {
                        authorization: 'Bearer 123',
                    },
                }),
                windowInstance.location.origin,
            );
        }) as any);

        const headers = await requestPlatformHeadersFromMainWorld('ChatGPT', 250);
        expect(headers?.authorization).toBe('Bearer 123');
    });

    it('should return undefined on timeout', async () => {
        const headers = await requestPlatformHeadersFromMainWorld('ChatGPT', 25);
        expect(headers).toBeUndefined();
    });

    it('should ignore mismatched token responses', async () => {
        windowInstance.addEventListener('message', ((event: MessageEvent) => {
            const request = event.data as PlatformHeadersRequestMessage;
            if (request?.type !== PLATFORM_HEADERS_REQUEST_MESSAGE) {
                return;
            }
            windowInstance.postMessage(
                {
                    type: PLATFORM_HEADERS_RESPONSE_MESSAGE,
                    requestId: request.requestId,
                    platformName: request.platformName,
                    headers: {
                        authorization: 'Bearer wrong',
                    },
                    __blackiyaToken: 'bk:wrong-token',
                },
                windowInstance.location.origin,
            );
        }) as any);

        const headers = await requestPlatformHeadersFromMainWorld('ChatGPT', 50);
        expect(headers).toBeUndefined();
        expect(getSessionToken()).toBe('bk:test-header-request');
    });
});
