import type { LLMPlatform } from '@/platforms/types';
import { generateTimestamp, sanitizeFilename } from '@/utils/download';
import type { ConversationData } from '@/utils/types';
import { NOVA_CONVERSATION_ID_PATTERN, NOVA_ORIGIN } from './constants';
import { isNovaConversationPayload, parseNovaConversationPayload } from './parser';
import { evaluateNovaReadiness } from './readiness';

const MAX_TITLE_LENGTH = 80;

const parseNovaUrl = (url: string): URL | null => {
    try {
        return new URL(url);
    } catch {
        return null;
    }
};

const isCanonicalNovaOrigin = (url: URL) => url.origin === NOVA_ORIGIN;

export const novaAdapter: LLMPlatform = {
    name: 'Amazon Nova',
    urlMatchPattern: 'https://nova.amazon.com/*',

    isPlatformUrl: (url) => {
        const parsed = parseNovaUrl(url);
        return !!parsed && isCanonicalNovaOrigin(parsed);
    },

    extractConversationId: (url) => {
        const parsed = parseNovaUrl(url);
        if (!parsed || !isCanonicalNovaOrigin(parsed)) {
            return null;
        }
        const match = parsed.pathname.match(/^\/conversation\/([^/]+)\/?$/);
        const conversationId = match?.[1] ?? null;
        return conversationId && NOVA_CONVERSATION_ID_PATTERN.test(conversationId) ? conversationId : null;
    },

    parseInterceptedData: (data, url) => {
        const parsedUrl = parseNovaUrl(url);
        if (
            !parsedUrl ||
            !isCanonicalNovaOrigin(parsedUrl) ||
            parsedUrl.pathname !== '/api' ||
            parsedUrl.search !== '' ||
            parsedUrl.hash !== ''
        ) {
            return null;
        }
        try {
            return parseNovaConversationPayload(JSON.parse(data));
        } catch {
            return null;
        }
    },

    isConversationPayload: isNovaConversationPayload,

    formatFilename: (data: ConversationData) => {
        const fallbackId = data.conversation_id.slice(0, 8) || 'unknown';
        const title = data.title.trim() || `amazon_nova_conversation_${fallbackId}`;
        const sanitizedTitle = sanitizeFilename(title).slice(0, MAX_TITLE_LENGTH);
        return `${sanitizedTitle}_${generateTimestamp(data.update_time || data.create_time)}`;
    },

    evaluateReadiness: evaluateNovaReadiness,
};
