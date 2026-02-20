import {
    shouldEmitCompletionForParsedData,
    shouldSuppressCompletion,
} from '@/entrypoints/interceptor/completion-policy';
import {
    parseConversationData,
    resolveParsedConversationId,
    resolveRequestConversationId,
} from '@/entrypoints/interceptor/conversation-utils';
import { isDiscoveryDiagnosticsEnabled, safePathname } from '@/entrypoints/interceptor/discovery';
import {
    isDiscoveryModeHost,
    logConversationSkip,
    logDiscoveryXhr,
    logGeminiAdapterMiss,
} from '@/entrypoints/interceptor/discovery-logging';
import {
    emitNonChatGptStreamSnapshot,
    type FetchInterceptionDeps,
    tryParseAndEmitConversation,
} from '@/entrypoints/interceptor/fetch-interception';
import type { ProactiveFetchRunner } from '@/entrypoints/interceptor/proactive-fetch-runner';
import { chatGPTAdapter } from '@/platforms/chatgpt';
import { getPlatformAdapterByApiUrl, getPlatformAdapterByCompletionUrl } from '@/platforms/factory';
import type { LLMPlatform } from '@/platforms/types';
import { toForwardableHeaderRecord } from '@/utils/proactive-fetch-headers';

export type XhrInterceptionDeps = FetchInterceptionDeps & {
    proactiveFetchRunner: ProactiveFetchRunner;
};

const processXhrApiMatch = (url: string, xhr: XMLHttpRequest, adapter: LLMPlatform, deps: XhrInterceptionDeps) => {
    const { emitter, resolveAttemptIdForConversation } = deps;
    try {
        emitter.log('info', `XHR API ${adapter.name}`);
        const parsed = parseConversationData(adapter, xhr.responseText, url);
        const conversationId = resolveParsedConversationId(adapter, parsed, url);
        const attemptId = resolveAttemptIdForConversation(conversationId, adapter.name);
        emitter.emitApiResponseDumpFrame(adapter.name, url, xhr.responseText, attemptId, conversationId);
        emitter.emitCapturePayload(url, xhr.responseText, adapter.name, attemptId);
        emitNonChatGptStreamSnapshot(adapter, attemptId, conversationId, parsed, emitter);
        if (
            adapter.name !== chatGPTAdapter.name &&
            parsed?.conversation_id &&
            shouldEmitCompletionForParsedData(adapter, url, parsed)
        ) {
            emitter.emitResponseFinished(adapter, url);
        }
    } catch {
        emitter.log('error', 'XHR read err');
    }
    return true;
};

const processXhrAuxConversation = (
    url: string,
    xhr: XMLHttpRequest,
    adapter: LLMPlatform,
    deps: XhrInterceptionDeps,
) => {
    deps.emitter.log('info', 'aux response', {
        path: safePathname(url),
        status: xhr.status,
        size: xhr.responseText?.length ?? 0,
    });
    if (xhr.status < 200 || xhr.status >= 300 || !xhr.responseText) {
        return;
    }
    if (!tryParseAndEmitConversation(adapter, url, xhr.responseText, 'aux', deps)) {
        if (deps.emitter.shouldLogTransient(`aux:miss:${safePathname(url)}`, 2500)) {
            deps.emitter.log('info', 'aux parse miss', { path: safePathname(url) });
        }
    }
};

/**
 * Main XHR load dispatcher. Mirrors the fetch interception logic but operates
 * on the synchronous `xhr.responseText` after the request completes.
 */
export const handleXhrLoad = (xhr: XMLHttpRequest, methodUpper: string, deps: XhrInterceptionDeps) => {
    const url = ((xhr as any)._url as string | undefined) ?? '';
    const apiAdapter = getPlatformAdapterByApiUrl(url);
    const completionAdapter = getPlatformAdapterByCompletionUrl(url);

    if (apiAdapter) {
        processXhrApiMatch(url, xhr, apiAdapter, deps);
        return;
    }
    if (completionAdapter) {
        processXhrAuxConversation(url, xhr, completionAdapter, deps);
        if (!shouldSuppressCompletion(completionAdapter, url)) {
            deps.emitter.emitResponseFinished(completionAdapter, url);
        }
        return;
    }
    if (url.includes('/backend-api/conversation/')) {
        logConversationSkip('XHR', url, deps.emitter.log, deps.emitter.shouldLogTransient);
        return;
    }
    if (
        isDiscoveryModeHost(window.location.hostname) &&
        methodUpper === 'POST' &&
        xhr.status === 200 &&
        isDiscoveryDiagnosticsEnabled()
    ) {
        try {
            logDiscoveryXhr(url, xhr.responseText, deps.emitter.log, deps.emitter.emitStreamDumpFrame);
        } catch {}
    }
    logGeminiAdapterMiss(
        'xhr',
        url,
        { method: methodUpper, status: xhr.status },
        deps.emitter.log,
        deps.emitter.shouldLogTransient,
    );
};

/**
 * Called from the XHR `load` event listener to log a Grok response and
 * optionally kick off a proactive conversation fetch.
 */
export const maybeRunXhrPostLoadSideEffects = (
    xhr: XMLHttpRequest,
    methodUpper: string,
    url: string,
    deps: XhrInterceptionDeps,
) => {
    if (methodUpper === 'POST') {
        const xhrAdapter = getPlatformAdapterByApiUrl(url);
        if (xhrAdapter?.name === 'Grok') {
            const conversationId = resolveRequestConversationId(xhrAdapter, url);
            const attemptId = deps.resolveAttemptIdForConversation(conversationId, 'Grok');
            if (deps.emitter.shouldLogTransient(`grok:xhr:response:${attemptId}`, 3000)) {
                deps.emitter.log('info', 'Grok XHR response intercepted', {
                    attemptId,
                    conversationId: conversationId ?? null,
                    status: xhr.status,
                    size: xhr.responseText?.length ?? 0,
                    path: safePathname(url),
                });
            }
        }
    }

    const completionAdapter = getPlatformAdapterByCompletionUrl(url);
    if (completionAdapter) {
        void deps.proactiveFetchRunner.trigger(
            completionAdapter,
            url,
            toForwardableHeaderRecord((xhr as any)._headers),
        );
    }

    if (
        isDiscoveryDiagnosticsEnabled() &&
        methodUpper === 'POST' &&
        xhr.status === 200 &&
        window.location.hostname.includes('gemini.google.com')
    ) {
        deps.emitter.log('info', '[DISCOVERY] Gemini XHR POST', {
            path: safePathname(url),
            status: xhr.status,
            size: xhr.responseText?.length ?? 0,
        });
    }
};
