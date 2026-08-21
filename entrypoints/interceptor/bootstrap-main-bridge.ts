import { setupStreamDebugBridge } from '@/features/stream-debug/bridge';
import { streamDebugRecorder } from '@/features/stream-debug/recorder';
import { getGeminiBatchexecuteContext } from '@/entrypoints/interceptor/gemini-batchexecute-context-store';
import {
    GEMINI_BATCHEXECUTE_CONTEXT_RESPONSE_MESSAGE,
    type GeminiBatchexecuteContextResponseMessage,
    isGeminiBatchexecuteContextRequestMessage,
} from '@/utils/gemini-batchexecute-bridge';
import {
    isPlatformHeadersRequestMessage,
    PLATFORM_HEADERS_RESPONSE_MESSAGE,
    type PlatformHeadersResponseMessage,
} from '@/utils/platform-header-bridge';
import { platformHeaderStore } from '@/utils/platform-header-store';
import { MESSAGE_TYPES } from '@/utils/protocol/constants';
import { getSessionToken, resolveTokenValidationFailureReason, setSessionToken, stampToken } from '@/utils/protocol/session-token';

const MAIN_BRIDGE_INSTALLED_KEY = '__BLACKIYA_MAIN_BRIDGE_INSTALLED__';

export const shouldApplySessionInitToken = (existingToken: string | undefined, incomingToken: string): boolean => {
    return typeof incomingToken === 'string' && incomingToken.length > 0 && !existingToken;
};

type SessionInitMessage = {
    type: typeof MESSAGE_TYPES.SESSION_INIT;
    token: string;
};

const isSameWindowOriginEvent = (event: MessageEvent): boolean =>
    event.source === window &&
    (!event.origin || event.origin === window.location.origin || event.origin === 'null');

export const setupMainWorldBridge = () => {
    if ((window as any)[MAIN_BRIDGE_INSTALLED_KEY] === true) {
        return;
    }
    (window as any)[MAIN_BRIDGE_INSTALLED_KEY] = true;

    setupStreamDebugBridge({ window: window as any, recorder: streamDebugRecorder });

    const handleSessionInit = (message: SessionInitMessage) => {
        if (shouldApplySessionInitToken(getSessionToken(), message.token)) {
            setSessionToken(message.token);
        }
    };

    const handleHeadersRequest = (message: unknown): boolean => {
        if (!isPlatformHeadersRequestMessage(message)) {
            return false;
        }
        if (resolveTokenValidationFailureReason(message) !== null) {
            return true;
        }
        const response: PlatformHeadersResponseMessage = {
            type: PLATFORM_HEADERS_RESPONSE_MESSAGE,
            requestId: message.requestId,
            platformName: message.platformName,
            headers: platformHeaderStore.get(message.platformName),
        };
        window.postMessage(stampToken(response), window.location.origin);
        return true;
    };

    const handleGeminiContextRequest = (message: unknown): boolean => {
        if (!isGeminiBatchexecuteContextRequestMessage(message)) {
            return false;
        }
        if (resolveTokenValidationFailureReason(message) !== null) {
            return true;
        }
        const response: GeminiBatchexecuteContextResponseMessage = {
            type: GEMINI_BATCHEXECUTE_CONTEXT_RESPONSE_MESSAGE,
            requestId: message.requestId,
            context: getGeminiBatchexecuteContext(),
        };
        window.postMessage(stampToken(response), window.location.origin);
        return true;
    };

    window.addEventListener('message', (event: MessageEvent) => {
        if (!isSameWindowOriginEvent(event) || !event.data || typeof event.data !== 'object') {
            return;
        }
        if (handleHeadersRequest(event.data) || handleGeminiContextRequest(event.data)) {
            return;
        }
        const message = event.data as Partial<SessionInitMessage>;
        if (message.type === MESSAGE_TYPES.SESSION_INIT && typeof message.token === 'string') {
            handleSessionInit(message as SessionInitMessage);
        }
    });
};
