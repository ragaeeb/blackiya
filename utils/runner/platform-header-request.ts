import {
    isPlatformHeadersResponseMessage,
    PLATFORM_HEADERS_REQUEST_MESSAGE,
    type PlatformHeadersRequestMessage,
} from '@/utils/platform-header-bridge';
import type { HeaderRecord } from '@/utils/proactive-fetch-headers';
import { resolveTokenValidationFailureReason, stampToken } from '@/utils/protocol/session-token';

const DEFAULT_PLATFORM_HEADERS_REQUEST_TIMEOUT_MS = 1_500;

const buildRequestId = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `headers-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const requestPlatformHeadersFromMainWorld = (
    platformName: string,
    timeoutMs = DEFAULT_PLATFORM_HEADERS_REQUEST_TIMEOUT_MS,
): Promise<HeaderRecord | undefined> => {
    if (!platformName || typeof window === 'undefined') {
        return Promise.resolve(undefined);
    }

    const requestId = buildRequestId();
    const request: PlatformHeadersRequestMessage = {
        type: PLATFORM_HEADERS_REQUEST_MESSAGE,
        requestId,
        platformName,
    };

    return new Promise((resolve) => {
        const timeout = window.setTimeout(() => {
            window.removeEventListener('message', onMessage);
            resolve(undefined);
        }, timeoutMs);

        const onMessage = (event: MessageEvent) => {
            if (event.source !== window || event.origin !== window.location.origin) {
                return;
            }
            if (!isPlatformHeadersResponseMessage(event.data)) {
                return;
            }
            if (event.data.requestId !== requestId || event.data.platformName !== platformName) {
                return;
            }
            if (resolveTokenValidationFailureReason(event.data) !== null) {
                return;
            }
            window.clearTimeout(timeout);
            window.removeEventListener('message', onMessage);
            resolve(event.data.headers);
        };

        window.addEventListener('message', onMessage);
        window.postMessage(stampToken(request), window.location.origin);
    });
};
