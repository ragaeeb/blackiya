import {
    GEMINI_BATCHEXECUTE_CONTEXT_REQUEST_MESSAGE,
    type GeminiBatchexecuteContext,
    type GeminiBatchexecuteContextRequestMessage,
    isGeminiBatchexecuteContextResponseMessage,
} from '@/utils/gemini-batchexecute-bridge';
import { resolveTokenValidationFailureReason, stampToken } from '@/utils/protocol/session-token';

const DEFAULT_GEMINI_CONTEXT_REQUEST_TIMEOUT_MS = 1_500;

const buildRequestId = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `gemini-context-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const requestGeminiBatchexecuteContextFromMainWorld = (
    timeoutMs = DEFAULT_GEMINI_CONTEXT_REQUEST_TIMEOUT_MS,
): Promise<GeminiBatchexecuteContext | undefined> => {
    if (typeof window === 'undefined') {
        return Promise.resolve(undefined);
    }

    const requestId = buildRequestId();
    const request: GeminiBatchexecuteContextRequestMessage = {
        type: GEMINI_BATCHEXECUTE_CONTEXT_REQUEST_MESSAGE,
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
            if (!isGeminiBatchexecuteContextResponseMessage(event.data)) {
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
