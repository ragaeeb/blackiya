import { shouldEmitLifecycleForRequest } from '@/entrypoints/interceptor/completion-policy';
import type { FetchInterceptorContext } from '@/entrypoints/interceptor/fetch-pipeline';
import type { InterceptorEmitter } from '@/entrypoints/interceptor/interceptor-emitter';
import { shouldEmitXhrRequestLifecycle } from '@/entrypoints/interceptor/signal-emitter';
import { monitorChatGptSseLifecycle } from '@/entrypoints/interceptor/stream-monitors/chatgpt-sse-lifecycle';
import {
    monitorGeminiResponseStream,
    wireGeminiXhrProgressMonitor,
} from '@/entrypoints/interceptor/stream-monitors/gemini-lifecycle';
import {
    monitorGrokResponseStream,
    wireGrokXhrProgressMonitor,
} from '@/entrypoints/interceptor/stream-monitors/grok-lifecycle';
import type { StreamMonitorEmitter } from '@/entrypoints/interceptor/stream-monitors/stream-emitter';
import {
    handleXhrLoad as handleXhrInterceptionLoad,
    maybeRunXhrPostLoadSideEffects,
    type XhrInterceptionDeps,
} from '@/entrypoints/interceptor/xhr-interception';
import type { XhrLifecycleContext } from '@/entrypoints/interceptor/xhr-pipeline';
import { chatGPTAdapter } from '@/platforms/chatgpt';
import type { LLMPlatform } from '@/platforms/types';
import { setBoundedMapValue } from '@/utils/bounded-collections';
import { isGrokStreamingEndpoint } from '@/utils/grok-request-classifier';

export type BootstrapRequestLifecycleDeps = {
    emitter: InterceptorEmitter;
    resolveAttemptIdForConversation: (conversationId?: string, platformName?: string) => string;
    bindAttemptToConversation: (attemptId: string | null | undefined, conversationId: string | undefined) => void;
    latestAttemptIdByPlatform: Map<string, string>;
    disposedAttemptIds: Set<string>;
    maxAttemptBindings: number;
    safePathname: (url: string) => string;
};

const GROK_CREATE_CONVERSATION_PATH_PATTERN = /\/i\/api\/graphql\/[^/]+\/CreateGrokConversation(?:\?|$)/i;
const GROK_ADD_RESPONSE_PATH_PATTERN = /\/2\/grok\/add_response\.json(?:\?|$)/i;

const normalizePromptCandidate = (value: unknown): string | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

const isPromptCandidateKey = (key: string): boolean => {
    return /(?:^|_)(message|prompt|query|text)(?:$|_)/i.test(key);
};

const isIgnoredPromptCandidateKey = (key: string): boolean => {
    return /(messageType|queryId|operationName|model|conversationId)/i.test(key);
};

const isLikelyGraphqlDocument = (value: string): boolean => {
    return /^\s*(mutation|query|fragment)\b[\s\S]*\{/.test(value);
};

const extractPromptFromRecord = (record: Record<string, unknown>): string | null => {
    for (const [key, candidate] of Object.entries(record)) {
        if (!isPromptCandidateKey(key) || isIgnoredPromptCandidateKey(key)) {
            continue;
        }
        if (key.toLowerCase() === 'query' && typeof candidate === 'string' && isLikelyGraphqlDocument(candidate)) {
            continue;
        }
        const prompt = normalizePromptCandidate(candidate);
        if (prompt) {
            return prompt;
        }
    }
    return null;
};

const enqueueNestedObjects = (record: Record<string, unknown>, queue: unknown[]) => {
    for (const value of Object.values(record)) {
        if (value && typeof value === 'object') {
            queue.push(value);
        }
    }
};

const extractPromptFromUnknownPayload = (value: unknown): string | null => {
    const directPrompt = normalizePromptCandidate(value);
    if (directPrompt) {
        return directPrompt;
    }
    if (!value || typeof value !== 'object') {
        return null;
    }

    const queue: unknown[] = [value];
    const visited = new Set<object>();
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || typeof current !== 'object') {
            continue;
        }
        if (visited.has(current)) {
            continue;
        }
        visited.add(current);
        const record = current as Record<string, unknown>;
        const prompt = extractPromptFromRecord(record);
        if (prompt) {
            return prompt;
        }
        enqueueNestedObjects(record, queue);
    }
    return null;
};

export const extractGrokPromptHintFromFetchArgs = (args: Parameters<typeof fetch>): string | null => {
    const body = args[1]?.body;
    if (typeof body !== 'string' || body.length === 0) {
        return null;
    }
    try {
        const parsed = JSON.parse(body);
        return extractPromptFromUnknownPayload(parsed);
    } catch {
        return null;
    }
};

const extractPromptHintFromBodyText = (bodyText: string): string | null => {
    if (!bodyText) {
        return null;
    }
    try {
        const parsed = JSON.parse(bodyText);
        return extractPromptFromUnknownPayload(parsed);
    } catch {
        return null;
    }
};

const readRequestBodyTextSafely = async (input: RequestInfo | URL): Promise<string | null> => {
    if (!(input instanceof Request)) {
        return null;
    }
    if (input.bodyUsed) {
        return null;
    }
    try {
        return await input.clone().text();
    } catch {
        return null;
    }
};

export const resolveGrokPromptHintFromFetchArgs = async (args: Parameters<typeof fetch>): Promise<string | null> => {
    const initBodyHint = extractGrokPromptHintFromFetchArgs(args);
    if (initBodyHint) {
        return initBodyHint;
    }
    const requestBodyText = await readRequestBodyTextSafely(args[0]);
    if (!requestBodyText) {
        return null;
    }
    return extractPromptHintFromBodyText(requestBodyText);
};

const isGrokCreateConversationRequest = (url: string): boolean => {
    return GROK_CREATE_CONVERSATION_PATH_PATTERN.test(url);
};

const isGrokAddResponseRequest = (url: string): boolean => {
    return GROK_ADD_RESPONSE_PATH_PATTERN.test(url);
};

const cachePromptHintFromGrokRequest = (
    context: FetchInterceptorContext,
    adapter: LLMPlatform,
    attemptId: string,
    emitter: BootstrapRequestLifecycleDeps['emitter'],
) => {
    if (adapter.name !== 'Grok' || !isGrokCreateConversationRequest(context.outgoingUrl)) {
        return;
    }
    const promptHint = extractGrokPromptHintFromFetchArgs(context.args);
    if (!promptHint) {
        return;
    }
    emitter.cachePromptHintForAttempt(attemptId, promptHint);
};

export const cachePromptHintFromGrokCreateConversationRequest = async (
    context: Pick<FetchInterceptorContext, 'args' | 'outgoingMethod' | 'outgoingUrl' | 'nonChatAttemptId'>,
    deps: Pick<BootstrapRequestLifecycleDeps, 'emitter' | 'resolveAttemptIdForConversation'>,
) => {
    if (
        context.outgoingMethod !== 'POST' ||
        (!isGrokCreateConversationRequest(context.outgoingUrl) && !isGrokAddResponseRequest(context.outgoingUrl))
    ) {
        return;
    }
    const promptHint = await resolveGrokPromptHintFromFetchArgs(context.args);
    if (!promptHint) {
        return;
    }
    const attemptId = context.nonChatAttemptId ?? deps.resolveAttemptIdForConversation(undefined, 'Grok');
    deps.emitter.cachePromptHintForAttempt(attemptId, promptHint);
};

export const shouldEmitNonChatLifecycleForRequest = (
    adapter: LLMPlatform,
    url: string,
    deps: Pick<BootstrapRequestLifecycleDeps, 'emitter'>,
) =>
    shouldEmitLifecycleForRequest(adapter, url, (path) => {
        if (adapter.name === 'Gemini') {
            if (deps.emitter.shouldLogTransient(`gemini:lifecycle-suppressed:${path}`, 8000)) {
                deps.emitter.log('info', 'Gemini lifecycle suppressed for non-generation endpoint', { path });
            }
            return;
        }
        if (adapter.name === 'Grok' && deps.emitter.shouldLogTransient(`grok:lifecycle-suppressed:${path}`, 8000)) {
            deps.emitter.log('info', 'Grok lifecycle suppressed for non-generation endpoint', { path });
        }
    });

export const emitFetchPromptLifecycle = (
    context: FetchInterceptorContext,
    deps: Pick<
        BootstrapRequestLifecycleDeps,
        | 'emitter'
        | 'resolveAttemptIdForConversation'
        | 'bindAttemptToConversation'
        | 'latestAttemptIdByPlatform'
        | 'disposedAttemptIds'
        | 'maxAttemptBindings'
    >,
) => {
    if (context.isChatGptPromptRequest && context.lifecycleAttemptId) {
        setBoundedMapValue(
            deps.latestAttemptIdByPlatform,
            chatGPTAdapter.name,
            context.lifecycleAttemptId,
            deps.maxAttemptBindings,
        );
        deps.disposedAttemptIds.delete(context.lifecycleAttemptId);
        deps.bindAttemptToConversation(context.lifecycleAttemptId, context.lifecycleConversationId);
        if (context.lifecycleConversationId) {
            deps.emitter.emitConversationIdResolved(context.lifecycleAttemptId, context.lifecycleConversationId);
        }
        deps.emitter.emitLifecycle(context.lifecycleAttemptId, 'prompt-sent', context.lifecycleConversationId);
        return;
    }

    if (!context.shouldEmitNonChatLifecycle || !context.fetchApiAdapter) {
        return;
    }
    const adapter = context.fetchApiAdapter;
    const attemptId =
        context.nonChatAttemptId ?? deps.resolveAttemptIdForConversation(context.nonChatConversationId, adapter.name);
    if (!attemptId) {
        return;
    }
    cachePromptHintFromGrokRequest(context, adapter, attemptId, deps.emitter);
    deps.emitter.emitLifecycle(attemptId, 'prompt-sent', context.nonChatConversationId, adapter.name);
    if (adapter.name !== 'Gemini') {
        deps.emitter.emitLifecycle(attemptId, 'streaming', context.nonChatConversationId, adapter.name);
    }
    if (adapter.name === 'Grok' && deps.emitter.shouldLogTransient(`grok:fetch:request:${attemptId}`, 3000)) {
        deps.emitter.log('info', 'Grok fetch request intercepted', {
            attemptId,
            conversationId: context.nonChatConversationId ?? null,
            method: context.outgoingMethod,
            path: context.outgoingPath,
        });
    }
};

export const maybeMonitorFetchStreams = (
    context: FetchInterceptorContext,
    response: Response,
    emit: StreamMonitorEmitter,
    deps: Pick<BootstrapRequestLifecycleDeps, 'emitter' | 'resolveAttemptIdForConversation' | 'safePathname'>,
) => {
    const contentType = response.headers.get('content-type') ?? '';

    if (context.isChatGptPromptRequest && contentType.includes('text/event-stream')) {
        void monitorChatGptSseLifecycle(
            response.clone(),
            context.lifecycleAttemptId ??
                deps.resolveAttemptIdForConversation(context.lifecycleConversationId, chatGPTAdapter.name),
            emit,
            context.lifecycleConversationId,
        );
    }

    if (context.isNonChatGptApiRequest && context.fetchApiAdapter?.name === 'Gemini' && context.nonChatAttemptId) {
        void monitorGeminiResponseStream(
            response.clone(),
            context.nonChatAttemptId,
            emit,
            context.nonChatConversationId,
        );
    }

    if (
        context.isNonChatGptApiRequest &&
        context.fetchApiAdapter?.name === 'Grok' &&
        context.nonChatAttemptId &&
        isGrokStreamingEndpoint(context.outgoingUrl)
    ) {
        if (deps.emitter.shouldLogTransient(`grok:fetch:response:${context.nonChatAttemptId}`, 3000)) {
            deps.emitter.log('info', 'Grok fetch response intercepted', {
                attemptId: context.nonChatAttemptId,
                conversationId: context.nonChatConversationId ?? null,
                status: response.status,
                contentType,
                path: deps.safePathname(context.outgoingUrl),
            });
        }
        void monitorGrokResponseStream(
            response.clone(),
            context.nonChatAttemptId,
            emit,
            context.nonChatConversationId,
            context.outgoingUrl,
            context.shouldEmitNonChatLifecycle,
        );
    }
};

const wireGeminiOrGrokXhrLifecycleMonitor = (
    xhr: XMLHttpRequest,
    context: XhrLifecycleContext,
    attemptId: string,
    emit: StreamMonitorEmitter,
    deps: Pick<BootstrapRequestLifecycleDeps, 'emitter' | 'safePathname'>,
) => {
    if (!context.requestAdapter) {
        return true;
    }
    if (context.requestAdapter.name === 'Gemini') {
        wireGeminiXhrProgressMonitor(xhr, attemptId, emit, context.conversationId, context.requestUrl);
        return true;
    }
    if (context.requestAdapter.name === 'Grok' && context.conversationId) {
        wireGrokXhrProgressMonitor(xhr, attemptId, emit, context.conversationId, context.requestUrl);
        if (deps.emitter.shouldLogTransient(`grok:xhr:request:${attemptId}`, 3000)) {
            deps.emitter.log('info', 'Grok XHR request intercepted', {
                attemptId,
                conversationId: context.conversationId,
                method: context.methodUpper,
                path: deps.safePathname(context.requestUrl),
            });
        }
        return true;
    }
    return false;
};

export const emitXhrRequestLifecycle = (
    xhr: XMLHttpRequest,
    context: XhrLifecycleContext,
    emit: StreamMonitorEmitter,
    deps: Pick<BootstrapRequestLifecycleDeps, 'emitter' | 'resolveAttemptIdForConversation' | 'safePathname'>,
) => {
    if (!context.shouldEmitNonChatLifecycle || !context.requestAdapter) {
        return;
    }
    const attemptId =
        context.attemptId ?? deps.resolveAttemptIdForConversation(context.conversationId, context.requestAdapter.name);
    if (!attemptId || !shouldEmitXhrRequestLifecycle({ ...context, attemptId })) {
        return;
    }
    deps.emitter.emitLifecycle(attemptId, 'prompt-sent', context.conversationId, context.requestAdapter.name);
    if (wireGeminiOrGrokXhrLifecycleMonitor(xhr, context, attemptId, emit, deps)) {
        return;
    }
    if (context.conversationId) {
        deps.emitter.emitLifecycle(attemptId, 'streaming', context.conversationId, context.requestAdapter.name);
    }
};

export const registerXhrLoadHandler = (xhr: XMLHttpRequest, methodUpper: string, deps: XhrInterceptionDeps) => {
    xhr.addEventListener('load', function () {
        const self = this as XMLHttpRequest;
        const xhrUrl = ((self as any)._url as string | undefined) ?? '';
        maybeRunXhrPostLoadSideEffects(self, methodUpper, xhrUrl, deps);
        handleXhrInterceptionLoad(self, methodUpper, deps);
    });
};
