import type { LLMPlatform } from '@/platforms/types';
import { generateTimestamp, sanitizeFilename } from '@/utils/download';
import type { ConversationData } from '@/utils/types';
import { isZaiConversationId, ZAI_HOST } from './constants';
import { isZaiConversationPayload, parseZaiConversationDetail } from './parser';
import { evaluateZaiReadiness } from './readiness';

const MAX_TITLE_LENGTH = 80;
const DETAIL_PATH_PATTERN = /^\/api\/v1\/chats\/([^/]+)\/?$/;

export type ZaiPlatformAdapter = LLMPlatform & {
    isConversationDetailRequest: (url: string, method: string) => boolean;
};

const parseZaiUrl = (url: string): URL | null => {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' &&
            parsed.hostname === ZAI_HOST &&
            !parsed.port &&
            !parsed.username &&
            !parsed.password
            ? parsed
            : null;
    } catch {
        return null;
    }
};

const extractEndpointConversationId = (pathname: string, pattern: RegExp): string | null => {
    const conversationId = pathname.match(pattern)?.[1];
    return isZaiConversationId(conversationId) ? conversationId : null;
};

export const zaiAdapter: ZaiPlatformAdapter = {
    name: 'Z.ai',
    urlMatchPattern: 'https://chat.z.ai/*',

    isPlatformUrl(url: string): boolean {
        return parseZaiUrl(url) !== null;
    },

    extractConversationId(url: string): string | null {
        const parsed = parseZaiUrl(url);
        if (!parsed) {
            return null;
        }
        const match = parsed.pathname.match(/^\/c\/([^/]+)\/?$/);
        const conversationId = match?.[1];
        return isZaiConversationId(conversationId) ? conversationId : null;
    },

    isConversationDetailRequest(): boolean {
        return false;
    },

    parseInterceptedData(data: string | unknown, url: string): ConversationData | null {
        const parsedUrl = parseZaiUrl(url);
        if (!parsedUrl) {
            return null;
        }

        const detailId = extractEndpointConversationId(parsedUrl.pathname, DETAIL_PATH_PATTERN);
        if (detailId) {
            return parseZaiConversationDetail(data, detailId);
        }

        return null;
    },

    formatFilename(data: ConversationData): string {
        const fallbackId = data.conversation_id.slice(0, 8) || 'unknown';
        const title =
            data.title.trim() && data.title !== 'Z.ai Conversation' ? data.title : `zai_conversation_${fallbackId}`;
        const sanitizedTitle = sanitizeFilename(title).slice(0, MAX_TITLE_LENGTH);
        return `${sanitizedTitle}_${generateTimestamp(data.update_time || data.create_time)}`;
    },

    isConversationPayload: isZaiConversationPayload,
    evaluateReadiness: evaluateZaiReadiness,
};
