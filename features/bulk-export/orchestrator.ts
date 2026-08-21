import type { V3BulkExportOptions } from '@/features/runtime/v3-runtime';
import type { LLMPlatform } from '@/platforms/types';
import type { GeminiBatchexecuteContext } from '@/utils/gemini-batchexecute-bridge';
import type { HeaderRecord } from '@/utils/proactive-fetch-headers';
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

export const runBulkExport = async (
    optionsInput: V3BulkExportOptions,
    deps: BulkExportDependencies,
): Promise<BulkExportChatsSuccessResponse['result']> => {
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
    const geminiContext = deps.getGeminiBatchexecuteContext?.();
    const startedAt = fetchContext.nowImpl();
    const listResult = await listConversationIds(platform, options, fetchContext, adapter, href);
    const ids = listResult.ids;
    const warnings = [...listResult.warnings];
    const progress = createProgressReporter(adapter.name, deps.onProgress);
    progress.started(ids.length);

    if (ids.length === 0) {
        warnings.push('No conversations discovered from list endpoint.');
    }

    let attempted = 0;
    let exported = 0;
    let failed = 0;
    const usedFilenames = new Set<string>();

    for (const conversationId of ids) {
        attempted += 1;
        const conversation = await fetchConversationById(
            conversationId,
            platform,
            adapter,
            fetchContext,
            href,
            geminiContext,
        );
        if (!conversation) {
            failed += 1;
            progress.progress({ discovered: ids.length, attempted, exported, failed });
            continue;
        }

        downloadCanonicalConversation(conversation, adapter, usedFilenames, deps.downloadImpl);
        exported += 1;
        progress.progress({ discovered: ids.length, attempted, exported, failed });
    }

    const result = {
        platform: adapter.name,
        discovered: ids.length,
        attempted,
        exported,
        failed,
        elapsedMs: fetchContext.nowImpl() - startedAt,
        limit: options.maxItems ?? 0,
        warnings,
    };
    progress.completed(result);
    return result;
};

export const createBulkExportRunner = (deps: BulkExportDependencies) =>
    (options: V3BulkExportOptions) => runBulkExport(options, deps);
