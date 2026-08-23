import type { LLMPlatform } from '@/platforms/types';
import { generateTimestamp, sanitizeFilename } from '@/utils/download';
import type { ConversationData } from '@/utils/types';
import { isMetaConversationPayload, parseMetaConversationPayload } from './parser';
import { evaluateMetaReadiness } from './readiness';
import { isMetaConversationId } from './request';

const META_HOSTS = new Set(['meta.ai', 'www.meta.ai']);
const MAX_TITLE_LENGTH = 80;

const parseMetaUrl = (value: string): URL | null => {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && META_HOSTS.has(url.hostname) ? url : null;
    } catch {
        return null;
    }
};

const isMetaGraphqlUrl = (value: string): boolean => parseMetaUrl(value)?.pathname === '/api/graphql';

export const metaAdapter: LLMPlatform = {
    name: 'Meta Muse',
    urlMatchPattern: 'https://www.meta.ai/*',

    isPlatformUrl: (url: string) => parseMetaUrl(url) !== null,

    extractConversationId(url: string): string | null {
        const parsed = parseMetaUrl(url);
        if (!parsed) {
            return null;
        }
        const match = parsed.pathname.match(/^\/prompt\/([^/]+)\/?$/);
        const conversationId = match?.[1] ?? null;
        return conversationId && isMetaConversationId(conversationId) ? conversationId : null;
    },

    parseInterceptedData(data: string, url: string): ConversationData | null {
        return isMetaGraphqlUrl(url) ? parseMetaConversationPayload(data) : null;
    },

    // Meta multiplexes detail, pagination, mutations, and unrelated queries on this one route.
    // The URL/method-only cache hook must therefore stay disabled until it receives request context.
    isConversationDetailRequest: () => false,

    isConversationPayload: isMetaConversationPayload,

    formatFilename(data: ConversationData): string {
        const title = data.title.trim() || `meta_muse_${data.conversation_id.slice(0, 8)}`;
        const sanitizedTitle = sanitizeFilename(title).slice(0, MAX_TITLE_LENGTH);
        return `${sanitizedTitle}_${generateTimestamp(data.update_time || data.create_time)}`;
    },

    evaluateReadiness: evaluateMetaReadiness,
};
