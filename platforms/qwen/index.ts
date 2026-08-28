import type { LLMPlatform } from '@/platforms/types';
import { generateTimestamp, sanitizeFilename } from '@/utils/download';
import type { ConversationData } from '@/utils/types';
import { QWEN_CONVERSATION_ID_PATTERN, QWEN_HOST } from './constants';
import { parseQwenConversationDetail } from './parser';
import { evaluateQwenReadiness } from './readiness';
import { buildQwenConversationDetailUrl, isQwenConversationDetailRequest } from './requests';

const MAX_TITLE_LENGTH = 80;

export const qwenAdapter: LLMPlatform = {
    name: 'Qwen',
    urlMatchPattern: 'https://chat.qwen.ai/*',
    detailRequestOrigins: ['https://chat.qwen.ai'],

    isPlatformUrl(url: string): boolean {
        try {
            const parsed = new URL(url);
            return parsed.protocol === 'https:' && parsed.hostname === QWEN_HOST;
        } catch {
            return false;
        }
    },

    extractConversationId(url: string): string | null {
        if (!this.isPlatformUrl(url)) {
            return null;
        }
        try {
            const match = new URL(url).pathname.match(/^\/c\/([^/]+)\/?$/);
            const conversationId = match?.[1] ?? null;
            return conversationId && QWEN_CONVERSATION_ID_PATTERN.test(conversationId) ? conversationId : null;
        } catch {
            return null;
        }
    },

    buildApiUrl(conversationId: string): string {
        return buildQwenConversationDetailUrl(conversationId) ?? '';
    },

    buildApiUrls(conversationId: string): string[] {
        const url = buildQwenConversationDetailUrl(conversationId);
        return url ? [url] : [];
    },

    isConversationDetailRequest(url: string, method: string): boolean {
        return isQwenConversationDetailRequest(url, method);
    },

    parseInterceptedData(data: unknown, url: string): ConversationData | null {
        return parseQwenConversationDetail(data, url);
    },

    formatFilename(data: ConversationData): string {
        const fallback = `qwen_conversation_${data.conversation_id.slice(0, 8)}`;
        const title = data.title.trim().length > 0 ? data.title : fallback;
        const sanitizedTitle = sanitizeFilename(title).slice(0, MAX_TITLE_LENGTH);
        const timestamp = generateTimestamp(data.update_time || data.create_time);
        return `${sanitizedTitle}_${timestamp}`;
    },

    evaluateReadiness(data: ConversationData) {
        return evaluateQwenReadiness(data);
    },
};
