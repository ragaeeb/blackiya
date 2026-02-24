import {
    shouldEmitCompletionForParsedData,
    shouldEmitCompletionForUrl,
    shouldSuppressCompletion,
} from '@/entrypoints/interceptor/completion-policy';
import {
    extractConversationIdFromAnyUrl,
    extractLatestAssistantText,
    parseConversationData,
    resolveParsedConversationId,
} from '@/entrypoints/interceptor/conversation-utils';
import { isDiscoveryDiagnosticsEnabled, safePathname } from '@/entrypoints/interceptor/discovery';
import {
    isDiscoveryModeHost,
    logAdapterEndpointMiss,
    logConversationSkip,
    logDiscoveryFetch,
} from '@/entrypoints/interceptor/discovery-logging';
import type { InterceptorEmitter } from '@/entrypoints/interceptor/interceptor-emitter';
import { chatGPTAdapter } from '@/platforms/chatgpt';
import { getPlatformAdapterByApiUrl, getPlatformAdapterByCompletionUrl } from '@/platforms/factory';
import type { LLMPlatform } from '@/platforms/types';
import type { ConversationData } from '@/utils/types';

export type FetchInterceptionDeps = {
    emitter: InterceptorEmitter;
    resolveAttemptIdForConversation: (conversationId?: string, platformName?: string) => string;
};

const utf8Encoder = new TextEncoder();
const getUtf8ByteLength = (text: string) => utf8Encoder.encode(text).byteLength;

/**
 * Emits a stream delta + dump frame with the latest assistant text for
 * non-ChatGPT adapters when a full parsed payload is available mid-stream.
 */
export const emitNonChatGptStreamSnapshot = (
    adapter: LLMPlatform,
    attemptId: string,
    conversationId: string | undefined,
    parsed: ConversationData | null,
    emitter: InterceptorEmitter,
) => {
    if (!parsed || adapter.name === chatGPTAdapter.name) {
        return;
    }
    const text = extractLatestAssistantText(parsed);
    if (!text) {
        return;
    }
    const chunkBytes = getUtf8ByteLength(text);
    emitter.emitStreamDelta(attemptId, conversationId, text, adapter.name);
    emitter.emitStreamDumpFrame(attemptId, conversationId, 'snapshot', text, chunkBytes, adapter.name);
};

/**
 * Parses intercepted text, deduplicates, and emits a capture payload +
 * optional stream snapshot and completion signal. Returns true when successfully
 * parsed (including deduplicated duplicates); false when parsing fails or no
 * conversation_id is present.
 */
export const tryParseAndEmitConversation = (
    adapter: LLMPlatform,
    url: string,
    text: string,
    source: string,
    deps: FetchInterceptionDeps,
) => {
    const parsed = parseConversationData(adapter, text, url);
    if (!parsed?.conversation_id) {
        return false;
    }

    const payload = JSON.stringify(parsed);
    if (!deps.emitter.shouldEmitCapturedPayload(adapter.name, url, payload)) {
        return true;
    }

    deps.emitter.log('info', `${source} captured ${adapter.name} ${parsed.conversation_id}`);
    const attemptId = deps.resolveAttemptIdForConversation(parsed.conversation_id, adapter.name);
    deps.emitter.emitCapturePayload(url, payload, adapter.name, attemptId);
    emitNonChatGptStreamSnapshot(adapter, attemptId, parsed.conversation_id, parsed, deps.emitter);
    if (adapter.name !== chatGPTAdapter.name && shouldEmitCompletionForParsedData(adapter, url, parsed)) {
        deps.emitter.emitResponseFinished(adapter, url);
    }
    return true;
};

export const handleApiMatchFromFetch = (
    url: string,
    adapter: LLMPlatform,
    response: Response,
    deps: FetchInterceptionDeps,
    deferredCompletionAdapter?: LLMPlatform,
) => {
    const { emitter, resolveAttemptIdForConversation } = deps;
    if (emitter.shouldLogTransient(`api:match:${adapter.name}:${safePathname(url)}`, 2500)) {
        emitter.log('info', `API match ${adapter.name}`);
    }
    const path = safePathname(url);
    const textPromise = response.clone().text();
    void textPromise.then(
        (text) => {
            const shouldCapture = emitter.shouldEmitCapturedPayload(adapter.name, url, text);
            if (shouldCapture) {
                emitter.log('info', `API ${text.length}b ${adapter.name}`);
            }

            const parsed = parseConversationData(adapter, text, url);
            const conversationId = resolveParsedConversationId(adapter, parsed, url);
            const attemptId = resolveAttemptIdForConversation(conversationId, adapter.name);

            if (shouldCapture) {
                emitter.emitApiResponseDumpFrame(adapter.name, url, text, attemptId, conversationId);
                emitter.emitCapturePayload(url, text, adapter.name, attemptId);
                emitNonChatGptStreamSnapshot(adapter, attemptId, conversationId, parsed, emitter);
            }

            if (
                deferredCompletionAdapter &&
                shouldEmitCompletionForParsedData(deferredCompletionAdapter, url, parsed)
            ) {
                emitter.emitResponseFinished(deferredCompletionAdapter, url);
                return;
            }
            if (
                adapter.name !== chatGPTAdapter.name &&
                parsed?.conversation_id &&
                shouldEmitCompletionForParsedData(adapter, url, parsed)
            ) {
                emitter.emitResponseFinished(adapter, url);
            }
        },
        () => {
            if (deferredCompletionAdapter && !shouldSuppressCompletion(deferredCompletionAdapter, url)) {
                emitter.emitResponseFinished(deferredCompletionAdapter, url);
            }
            if (adapter.name !== chatGPTAdapter.name || !path.startsWith('/backend-api/f/conversation')) {
                if (emitter.shouldLogTransient(`api:read-miss:${adapter.name}:${path}`, 10_000)) {
                    emitter.log('info', `API read miss ${adapter.name}`, { path, nonFatal: true });
                }
            }
        },
    );
};

export const inspectAuxConversationFetch = (
    url: string,
    response: Response,
    adapter: LLMPlatform,
    deps: FetchInterceptionDeps,
) => {
    response
        .clone()
        .text()
        .then((text) => {
            deps.emitter.log('info', 'aux response', {
                path: safePathname(url),
                status: response.status,
                size: text.length,
            });
            if (!response.ok || text.length === 0) {
                return;
            }

            const conversationId = extractConversationIdFromAnyUrl(url);
            const attemptId = deps.resolveAttemptIdForConversation(conversationId, adapter.name);
            if (text.length > 100) {
                deps.emitter.emitApiResponseDumpFrame(adapter.name, url, text, attemptId, conversationId);
            }

            if (!tryParseAndEmitConversation(adapter, url, text, 'aux', deps)) {
                if (deps.emitter.shouldLogTransient(`aux:miss:${safePathname(url)}`, 2500)) {
                    deps.emitter.log('info', 'aux parse miss', { path: safePathname(url) });
                }
            }
        })
        .catch(() => {
            deps.emitter.log('info', 'aux read err', { path: safePathname(url) });
        });
};

/**
 * Main fetch interception dispatcher. Classifies the URL against adapter
 * registries and delegates to the appropriate handler.
 */
export const handleFetchInterception = (
    args: Parameters<typeof fetch>,
    response: Response,
    deps: FetchInterceptionDeps,
) => {
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    const apiAdapter = getPlatformAdapterByApiUrl(url);
    const completionAdapter = getPlatformAdapterByCompletionUrl(url);

    if (apiAdapter) {
        handleApiMatchFromFetch(url, apiAdapter, response, deps, completionAdapter ?? undefined);
        return;
    }
    if (completionAdapter) {
        if (shouldEmitCompletionForUrl(completionAdapter, url)) {
            deps.emitter.emitResponseFinished(completionAdapter, url);
        }
        inspectAuxConversationFetch(url, response, completionAdapter, deps);
        return;
    }
    if (url.includes('/backend-api/conversation/')) {
        logConversationSkip('API', url, deps.emitter.log, deps.emitter.shouldLogTransient);
        return;
    }
    const method = args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET');
    if (
        method === 'POST' &&
        response.ok &&
        isDiscoveryModeHost(window.location.hostname) &&
        isDiscoveryDiagnosticsEnabled()
    ) {
        logDiscoveryFetch(url, response, deps.emitter.log, deps.emitter.emitStreamDumpFrame);
    }
    logAdapterEndpointMiss('fetch', url, undefined, deps.emitter.log, deps.emitter.shouldLogTransient);
};
