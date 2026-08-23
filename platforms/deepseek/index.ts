import type { LLMPlatform } from '@/platforms/types';
import { generateTimestamp, sanitizeFilename } from '@/utils/download';
import type { ConversationData } from '@/utils/types';

import { isDeepSeekHistoryPayload, parseDeepSeekHistoryResponse } from './parser';
import { evaluateDeepSeekReadiness } from './readiness';
import {
    buildDeepSeekHistoryRequest,
    DEEPSEEK_CONVERSATION_ID_PATTERN,
    parseDeepSeekHistoryRequestContext,
} from './request';

const MAX_TITLE_LENGTH = 80;
const DEEPSEEK_HOSTNAME = 'chat.deepseek.com';

const isDeepSeekUrl = (url: string) => {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.hostname === DEEPSEEK_HOSTNAME;
    } catch {
        return false;
    }
};

export const deepSeekAdapter: LLMPlatform = {
    name: 'DeepSeek',
    urlMatchPattern: 'https://chat.deepseek.com/*',

    isPlatformUrl: isDeepSeekUrl,

    extractConversationId(url: string): string | null {
        if (!isDeepSeekUrl(url)) {
            return null;
        }
        const pathname = new URL(url).pathname;
        const conversationId = pathname.match(/^\/a\/chat\/s\/([^/]+)\/?$/)?.[1] ?? null;
        return conversationId && DEEPSEEK_CONVERSATION_ID_PATTERN.test(conversationId) ? conversationId : null;
    },

    buildApiUrl(conversationId: string): string {
        return buildDeepSeekHistoryRequest(conversationId)?.url ?? '';
    },

    buildApiUrls(conversationId: string): string[] {
        const request = buildDeepSeekHistoryRequest(conversationId);
        return request ? [request.url] : [];
    },

    isConversationDetailRequest(url: string, method: string): boolean {
        return method.toUpperCase() === 'GET' && parseDeepSeekHistoryRequestContext(url) !== null;
    },

    parseInterceptedData(data: string, url: string): ConversationData | null {
        return parseDeepSeekHistoryResponse(data, url);
    },

    isConversationPayload(payload: unknown): boolean {
        return isDeepSeekHistoryPayload(payload);
    },

    formatFilename(data: ConversationData): string {
        const fallbackId = data.conversation_id.slice(0, 8) || 'unknown';
        const title = data.title.trim() || `deepseek_conversation_${fallbackId}`;
        const sanitizedTitle = sanitizeFilename(title).slice(0, MAX_TITLE_LENGTH);
        const timestamp = generateTimestamp(data.update_time || data.create_time);
        return `${sanitizedTitle}_${timestamp}`;
    },

    evaluateReadiness(data: ConversationData) {
        return evaluateDeepSeekReadiness(data);
    },
};
