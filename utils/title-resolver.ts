import type { ConversationData } from '@/utils/types';

const COMMON_GENERIC_TITLES = new Set([
    'gemini',
    'gemini advanced',
    'google gemini',
    'new chat',
    'new conversation',
    'chats',
    'chatgpt',
    'gemini conversation',
    'conversation with gemini',
    'grok conversation',
    'grok / x',
]);

const normalizeTitle = (title: string | null | undefined): string => {
    if (typeof title !== 'string') {
        return '';
    }
    return title.replace(/\s+/g, ' ').trim();
};

export const normalizeConversationTitle = (title: string | null | undefined): string => {
    return normalizeTitle(title);
};

export const isGenericConversationTitle = (
    title: string | null | undefined,
    options: {
        platformDefaultTitles?: string[];
    } = {},
): boolean => {
    const normalized = normalizeTitle(title).toLowerCase();
    if (normalized.length === 0) {
        return true;
    }
    if (COMMON_GENERIC_TITLES.has(normalized)) {
        return true;
    }
    if (normalized.startsWith('you said ') || normalized.startsWith('you said:')) {
        return true;
    }
    if (
        options.platformDefaultTitles?.some((defaultTitle) => normalizeTitle(defaultTitle).toLowerCase() === normalized)
    ) {
        return true;
    }
    return false;
};

export const deriveConversationTitleFromFirstUserMessage = (data: ConversationData, maxLength = 80): string | null => {
    const userMessages = Object.values(data.mapping)
        .map((node) => node.message)
        .filter(
            (message): message is NonNullable<(typeof data.mapping)[string]['message']> =>
                !!message && message.author.role === 'user',
        )
        .sort((left, right) => {
            const leftTs = left.create_time ?? left.update_time ?? 0;
            const rightTs = right.create_time ?? right.update_time ?? 0;
            return leftTs - rightTs;
        });

    for (const message of userMessages) {
        const text = (message.content.parts ?? []).filter((part): part is string => typeof part === 'string').join(' ');
        const normalized = text.replace(/\s+/g, ' ').trim();
        if (normalized.length === 0) {
            continue;
        }
        return normalized.length > maxLength ? normalized.slice(0, maxLength).trimEnd() : normalized;
    }
    return null;
};

export type ResolvedConversationTitleSource = 'stream' | 'cache' | 'dom' | 'first-user-message' | 'fallback';

export const resolveConversationTitleByPrecedence = (options: {
    streamTitle?: string | null;
    cachedTitle?: string | null;
    domTitle?: string | null;
    firstUserMessageTitle?: string | null;
    fallbackTitle?: string | null;
    platformDefaultTitles?: string[];
}): { title: string; source: ResolvedConversationTitleSource } => {
    const sourceCandidates: Array<{ source: ResolvedConversationTitleSource; title: string | null | undefined }> = [
        { source: 'stream', title: options.streamTitle },
        { source: 'cache', title: options.cachedTitle },
        { source: 'dom', title: options.domTitle },
    ];

    for (const candidate of sourceCandidates) {
        const normalized = normalizeTitle(candidate.title);
        if (!normalized) {
            continue;
        }
        if (isGenericConversationTitle(normalized, { platformDefaultTitles: options.platformDefaultTitles })) {
            continue;
        }
        return { title: normalized, source: candidate.source };
    }

    const promptTitle = normalizeTitle(options.firstUserMessageTitle);
    if (promptTitle.length > 0) {
        return { title: promptTitle, source: 'first-user-message' };
    }

    const fallback = normalizeTitle(options.fallbackTitle) || 'Conversation';
    return { title: fallback, source: 'fallback' };
};

export type ExportTitleSource = 'existing' | 'first-user-message' | 'fallback';

export const resolveExportConversationTitleDecision = (
    data: ConversationData,
): {
    title: string;
    source: ExportTitleSource;
} => {
    if (!isGenericConversationTitle(data.title)) {
        return { title: normalizeTitle(data.title), source: 'existing' };
    }
    const firstUserMessageTitle = deriveConversationTitleFromFirstUserMessage(data);
    if (firstUserMessageTitle) {
        return { title: firstUserMessageTitle, source: 'first-user-message' };
    }
    return { title: normalizeTitle(data.title) || 'Conversation', source: 'fallback' };
};
