import { resolveTokenValidationFailureReason, stampToken } from '@/utils/protocol/session-token';
import {
    isXGrokGraphqlContextResponseMessage,
    X_GROK_GRAPHQL_CONTEXT_REQUEST_MESSAGE,
    type XGrokGraphqlContext,
    type XGrokGraphqlContextRequestMessage,
} from '@/utils/x-grok-graphql-bridge';

const DEFAULT_X_GROK_CONTEXT_REQUEST_TIMEOUT_MS = 1_500;

const buildRequestId = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `x-grok-context-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const requestXGrokGraphqlContextFromMainWorld = (
    timeoutMs = DEFAULT_X_GROK_CONTEXT_REQUEST_TIMEOUT_MS,
): Promise<XGrokGraphqlContext | undefined> => {
    if (typeof window === 'undefined') {
        return Promise.resolve(undefined);
    }

    const requestId = buildRequestId();
    const request: XGrokGraphqlContextRequestMessage = {
        type: X_GROK_GRAPHQL_CONTEXT_REQUEST_MESSAGE,
        requestId,
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
            if (!isXGrokGraphqlContextResponseMessage(event.data)) {
                return;
            }
            if (event.data.requestId !== requestId) {
                return;
            }
            if (resolveTokenValidationFailureReason(event.data) !== null) {
                return;
            }
            window.clearTimeout(timeout);
            window.removeEventListener('message', onMessage);
            resolve(event.data.context);
        };

        window.addEventListener('message', onMessage);
        window.postMessage(stampToken(request), window.location.origin);
    });
};
