import type { V3BulkExportOptions } from '@/features/runtime/v3-runtime';
import type { LLMPlatform } from '@/platforms/types';
import type { GeminiBatchexecuteContext } from '@/utils/gemini-batchexecute-bridge';
import type { HeaderRecord } from '@/utils/proactive-fetch-headers';
import type { ConversationData } from '@/utils/types';
import type { BulkExportChatsSuccessResponse, BulkExportProgressMessage } from './contract';
import { downloadCanonicalConversation, type BulkDownloadImpl } from './downloads';
import type { FetchContext, FetchImplementation } from './fetch';
import { normalizeOptions } from './options';
import { createProgressReporter } from './progress';
import { fetchConversationByIdChatGpt, listConversationIdsChatGpt } from './provider-chatgpt';
import { fetchConversationByIdGemini, listConversationIdsGemini } from './provider-gemini';
import { fetchConversationByIdGrokCom, listConversationIdsGrokCom } from './provider-grok';

const sleep = (milliseconds: number) =>
    new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));

export type PlatformKind = 'chatgpt' | 'gemini' | 'grok-com' | 'unsupported';

export type BulkExportDependencies = {
    getAdapter: () => LLMPlatform | null;
    getAuthHeaders: () => HeaderRecord | undefined;
    getGeminiBatchexecuteContext?: () => GeminiBatchexecuteContext | undefined;
    fetchImpl?: FetchImplementation;
    downloadImpl?: BulkDownloadImpl;
    sleepImpl?: (milliseconds: number) => Promise<void>;
    nowImpl?: () => number;
    locationHref?: () => string;
    onProgress?: (message: BulkExportProgressMessage) => void;
};

export const resolvePlatformKind = (adapter: LLMPlatform, locationHref: string): PlatformKind => {
    if (adapter.name === 'ChatGPT') {
        return 'chatgpt';
    }
    if (adapter.name === 'Gemini') {
        return 'gemini';
    }
    if (adapter.name !== 'Grok') {
        return 'unsupported';
    }

    try {
        return new URL(locationHref).hostname === 'grok.com' ? 'grok-com' : 'unsupported';
    } catch {
        return 'unsupported';
    }
};

type ConversationListResult = {
    ids: string[];
    warnings: string[];
};

const listConversationIds = async (
    platform: PlatformKind,
    options: ReturnType<typeof normalizeOptions>,
    fetchContext: FetchContext,
    adapter: LLMPlatform,
    locationHref: string,
): Promise<ConversationListResult> => {
    if (platform === 'chatgpt') {
        return listConversationIdsChatGpt(options, fetchContext, locationHref);
    }
    if (platform === 'gemini') {
        return listConversationIdsGemini(options, fetchContext, locationHref, adapter);
    }
    if (platform === 'grok-com') {
        return listConversationIdsGrokCom(options, fetchContext);
    }
    return { ids: [], warnings: [] };
};

const fetchConversationById = async (
    conversationId: string,
    platform: PlatformKind,
    adapter: LLMPlatform,
    fetchContext: FetchContext,
    locationHref: string,
    geminiContext: GeminiBatchexecuteContext | undefined,
) => {
    if (platform === 'chatgpt') {
        return fetchConversationByIdChatGpt(conversationId, adapter, fetchContext, locationHref);
    }
    if (platform === 'gemini') {
        return fetchConversationByIdGemini(conversationId, adapter, fetchContext, locationHref, geminiContext);
    }
    if (platform === 'grok-com') {
        return fetchConversationByIdGrokCom(conversationId, adapter, fetchContext);
    }
    return null;
};

const exportConversation = async (
    conversationId: string,
    platform: PlatformKind,
    adapter: LLMPlatform,
    fetchContext: FetchContext,
    locationHref: string,
    geminiContext: GeminiBatchexecuteContext | undefined,
    usedFilenames: Set<string>,
    downloadImpl: BulkDownloadImpl | undefined,
) => {
    const conversation = await fetchConversationById(
        conversationId,
        platform,
        adapter,
        fetchContext,
        locationHref,
        geminiContext,
    );
    if (!conversation) {
        return false;
    }

    if (!isConversationReadyForExport(conversationId, conversation, adapter)) {
        return false;
    }

    return downloadCanonicalConversation(conversation, adapter, usedFilenames, downloadImpl).downloaded;
};

const inferTerminalReadiness = (conversation: ConversationData): boolean => {
    const messages = Object.values(conversation.mapping ?? {})
        .map((node) => node.message)
        .filter((message): message is NonNullable<ConversationData['mapping'][string]['message']> => {
            return message?.author.role === 'assistant';
        })
        .sort((left, right) => {
            const leftTimestamp = left.update_time ?? left.create_time ?? 0;
            const rightTimestamp = right.update_time ?? right.create_time ?? 0;
            return leftTimestamp - rightTimestamp;
        });

    if (messages.length === 0 || messages.some((message) => message.status === 'in_progress')) {
        return false;
    }

    const latest = messages.at(-1);
    if (latest?.status !== 'finished_successfully' || latest.end_turn !== true) {
        return false;
    }

    const text = [
        (latest.content.parts ?? []).filter((part): part is string => typeof part === 'string').join(''),
        typeof latest.content.content === 'string' ? latest.content.content : '',
    ].join('');
    return text.trim().length > 0;
};

const isConversationReadyForExport = (
    requestedConversationId: string,
    conversation: ConversationData,
    adapter: LLMPlatform,
): boolean => {
    if (conversation.conversation_id !== requestedConversationId) {
        return false;
    }

    try {
        const readiness = adapter.evaluateReadiness?.(conversation);
        return readiness ? readiness.ready && readiness.terminal : inferTerminalReadiness(conversation);
    } catch {
        return false;
    }
};

type BulkExportContext = {
    adapter: LLMPlatform;
    platform: PlatformKind;
    href: string;
    options: ReturnType<typeof normalizeOptions>;
    fetchContext: FetchContext;
    geminiContext: GeminiBatchexecuteContext | undefined;
    startedAt: number;
};

const createBulkExportContext = (
    optionsInput: V3BulkExportOptions,
    deps: BulkExportDependencies,
): BulkExportContext => {
    const adapter = deps.getAdapter();
    if (!adapter) {
        throw new Error('No supported platform found for this tab.');
    }

    const locationHref = deps.locationHref ?? (() => globalThis.location?.href ?? '');
    const href = locationHref();
    const platform = resolvePlatformKind(adapter, href);
    if (platform === 'unsupported') {
        throw new Error(`Bulk export is not supported for ${adapter.name} on this page yet.`);
    }

    const options = normalizeOptions(optionsInput);
    const fetchContext: FetchContext = {
        fetchImpl: deps.fetchImpl ?? fetch,
        sleepImpl: deps.sleepImpl ?? sleep,
        nowImpl: deps.nowImpl ?? Date.now,
        authHeaders: deps.getAuthHeaders(),
        timeoutMs: options.timeoutMs,
        delayMs: options.delayMs,
        platformName: adapter.name,
        requestCount: 0,
    };

    return {
        adapter,
        platform,
        href,
        options,
        fetchContext,
        geminiContext: deps.getGeminiBatchexecuteContext?.(),
        startedAt: fetchContext.nowImpl(),
    };
};

type ConversationExportOutcome =
    | { ok: true; downloaded: boolean }
    | { ok: false; error: unknown };

const exportConversationSafely = async (
    conversationId: string,
    context: BulkExportContext,
    usedFilenames: Set<string>,
    downloadImpl: BulkDownloadImpl | undefined,
): Promise<ConversationExportOutcome> => {
    try {
        return {
            ok: true,
            downloaded: await exportConversation(
                conversationId,
                context.platform,
                context.adapter,
                context.fetchContext,
                context.href,
                context.geminiContext,
                usedFilenames,
                downloadImpl,
            ),
        };
    } catch (error) {
        return { ok: false, error };
    }
};

type BulkExportCounts = {
    discovered: number;
    attempted: number;
    exported: number;
    failed: number;
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const runBulkExportWithProgress = async (
    context: BulkExportContext,
    deps: BulkExportDependencies,
    progress: ReturnType<typeof createProgressReporter>,
    counts: BulkExportCounts,
) => {
    const listResult = await listConversationIds(
        context.platform,
        context.options,
        context.fetchContext,
        context.adapter,
        context.href,
    );
    const ids = listResult.ids;
    const warnings = [...listResult.warnings];
    counts.discovered = ids.length;
    progress.started(counts.discovered);

    if (ids.length === 0) {
        warnings.push('No conversations discovered from list endpoint.');
    }

    const usedFilenames = new Set<string>();
    for (const conversationId of ids) {
        counts.attempted += 1;
        const outcome = await exportConversationSafely(
            conversationId,
            context,
            usedFilenames,
            deps.downloadImpl,
        );
        if (!outcome.ok) {
            counts.failed += 1;
            throw outcome.error;
        }
        if (outcome.downloaded) {
            counts.exported += 1;
        } else {
            counts.failed += 1;
        }
        progress.progress(counts);
    }

    const result = {
        platform: context.adapter.name,
        discovered: counts.discovered,
        attempted: counts.attempted,
        exported: counts.exported,
        failed: counts.failed,
        elapsedMs: context.fetchContext.nowImpl() - context.startedAt,
        limit: context.options.maxItems ?? 0,
        warnings,
    };
    progress.completed(result);
    return result;
};

export const runBulkExport = async (
    optionsInput: V3BulkExportOptions,
    deps: BulkExportDependencies,
): Promise<BulkExportChatsSuccessResponse['result']> => {
    const context = createBulkExportContext(optionsInput, deps);
    const progress = createProgressReporter(context.adapter.name, deps.onProgress);
    const counts: BulkExportCounts = {
        discovered: 0,
        attempted: 0,
        exported: 0,
        failed: 0,
    };
    try {
        return await runBulkExportWithProgress(context, deps, progress, counts);
    } catch (error) {
        progress.failed(counts, errorMessage(error));
        throw error;
    }
};

export const createBulkExportRunner = (deps: BulkExportDependencies) =>
    (options: V3BulkExportOptions) => runBulkExport(options, deps);
