import type { LLMPlatform } from '@/platforms/types';
import { generateTimestamp, sanitizeFilename } from '@/utils/download';
import type { ConversationData } from '@/utils/types';
import { isClaudeConversationPayload, parseClaudeInterceptedData } from './conversation-parser';
import { evaluateClaudeReadiness } from './readiness';
import { CLAUDE_UUID_PATTERN, isClaudeConversationDetailRequest } from './request';

const MAX_TITLE_LENGTH = 80;
const CLAUDE_CONVERSATION_PATH = /^\/chat\/([^/]+)\/?$/;

const parseClaudePageUrl = (url: string): URL | null => {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.hostname === 'claude.ai' ? parsed : null;
    } catch {
        return null;
    }
};

export const createClaudeAdapter = (): LLMPlatform => ({
    name: 'Claude',
    urlMatchPattern: 'https://claude.ai/*',

    isPlatformUrl: (url: string) => parseClaudePageUrl(url) !== null,

    extractConversationId: (url: string) => {
        const parsed = parseClaudePageUrl(url);
        const conversationId = parsed?.pathname.match(CLAUDE_CONVERSATION_PATH)?.[1] ?? '';
        return CLAUDE_UUID_PATTERN.test(conversationId) ? conversationId : null;
    },

    parseInterceptedData: (data: string, url: string) => parseClaudeInterceptedData(data, url),

    isConversationPayload: (payload: unknown) => isClaudeConversationPayload(payload),

    isConversationDetailRequest: (url: string, method: string) => isClaudeConversationDetailRequest(url, method),

    formatFilename: (data: ConversationData) => {
        const fallbackTitle = `Claude Conversation ${data.conversation_id.slice(0, 8)}`;
        const sanitizedTitle = sanitizeFilename(data.title || fallbackTitle).slice(0, MAX_TITLE_LENGTH);
        return `${sanitizedTitle}_${generateTimestamp(data.update_time || data.create_time)}`;
    },

    evaluateReadiness: (data: ConversationData) => evaluateClaudeReadiness(data),
});

export const claudeAdapter: LLMPlatform = createClaudeAdapter();
