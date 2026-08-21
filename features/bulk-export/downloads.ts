import type { LLMPlatform } from '@/platforms/types';
import { downloadAsJSON } from '@/utils/download';
import type { ConversationData } from '@/utils/types';
import { ensureUniqueFilename } from './utils';
import { resolveExportConversationTitleDecision } from '@/utils/title-resolver';

export type CanonicalExportMeta = {
    captureSource: 'canonical_api';
    fidelity: 'high';
    completeness: 'complete';
};

export type BulkDownload = {
    payload: unknown;
    filename: string;
};

export type BulkDownloadResult = BulkDownload & {
    downloaded: boolean;
};

export type BulkDownloadImpl = (payload: unknown, filename: string) => unknown;

export const attachCanonicalExportMeta = (payload: unknown): unknown => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return payload;
    }

    const record = payload as Record<string, unknown>;
    const existingBlackiya =
        record.__blackiya && typeof record.__blackiya === 'object' && !Array.isArray(record.__blackiya)
            ? (record.__blackiya as Record<string, unknown>)
            : {};

    return {
        ...record,
        __blackiya: {
            ...existingBlackiya,
            exportMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            } satisfies CanonicalExportMeta,
        },
    };
};

export const prepareCanonicalDownload = (
    conversation: ConversationData,
    adapter: LLMPlatform,
    usedFilenames: Set<string>,
): BulkDownload => {
    const titleDecision = resolveExportConversationTitleDecision(conversation);
    conversation.title = titleDecision.title;
    const payload = attachCanonicalExportMeta(conversation);
    const filename = ensureUniqueFilename(adapter.formatFilename(conversation), usedFilenames);
    return { payload, filename };
};

export const downloadCanonicalConversation = (
    conversation: ConversationData,
    adapter: LLMPlatform,
    usedFilenames: Set<string>,
    downloadImpl: BulkDownloadImpl = downloadAsJSON,
): BulkDownloadResult => {
    const download = prepareCanonicalDownload(conversation, adapter, usedFilenames);
    return {
        ...download,
        downloaded: downloadImpl(download.payload, download.filename) !== false,
    };
};
