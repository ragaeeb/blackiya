/**
 * ChatGPT Platform Adapter
 *
 * Implements the LLMPlatform interface for ChatGPT.
 * Handles conversation ID extraction, API URL building, and filename formatting.
 *
 * @module platforms/chatgpt
 */

import type { LLMPlatform, PlatformReadiness } from '@/platforms/types';
import { generateTimestamp, sanitizeFilename } from '@/utils/download';
import { logger } from '@/utils/logger';
import type { ConversationData, Message, MessageContent, MessageNode } from '@/utils/types';

/**
 * Regex pattern to match a valid ChatGPT conversation UUID
 * Format: 8-4-4-4-12 hex characters
 * Anchored and case-insensitive
 */
const CONVERSATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HOST_CANDIDATES = ['https://chatgpt.com', 'https://chat.openai.com'];
const PLACEHOLDER_TITLE_PATTERNS = [/^new chat$/i, /^new conversation$/i, /^untitled$/i];

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function hashText(value: string): string {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = (hash << 5) - hash + value.charCodeAt(i);
        hash |= 0;
    }
    return `${hash}`;
}

function normalizeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeConversationId(candidate: Record<string, unknown>): string | null {
    const conversationId = normalizeText(candidate.conversation_id) ?? normalizeText(candidate.id);
    if (!conversationId || !CONVERSATION_ID_PATTERN.test(conversationId)) {
        return null;
    }
    return conversationId;
}

function getConversationCandidate(parsed: unknown): unknown {
    if (!isRecord(parsed)) {
        return parsed;
    }
    if (isRecord(parsed.conversation)) {
        return parsed.conversation;
    }
    if (isRecord(parsed.data) && isRecord((parsed.data as Record<string, unknown>).conversation)) {
        return (parsed.data as Record<string, unknown>).conversation;
    }
    return parsed;
}

function normalizeModelSlug(value: unknown): string | null {
    const normalized = normalizeText(value);
    if (!normalized || normalized.toLowerCase() === 'auto') {
        return null;
    }
    return normalized;
}

function extractMappingModelSlug(mapping: Record<string, MessageNode>): string | null {
    for (const node of Object.values(mapping)) {
        const metadata = node.message?.metadata;
        if (!metadata) {
            continue;
        }
        const resolved =
            normalizeModelSlug(metadata.resolved_model_slug) ||
            normalizeModelSlug(metadata.model_slug) ||
            normalizeModelSlug(metadata.model);
        if (resolved) {
            return resolved;
        }
    }
    return null;
}

function deriveCurrentNode(mapping: Record<string, MessageNode>): string {
    let bestNodeId = 'root';
    let bestTime = -1;

    for (const [id, node] of Object.entries(mapping)) {
        const message = node.message;
        if (!message) {
            continue;
        }
        const messageTime = normalizeNumber(message.update_time) ?? normalizeNumber(message.create_time) ?? 0;
        if (messageTime >= bestTime) {
            bestNodeId = id;
            bestTime = messageTime;
        }
    }

    return bestNodeId;
}

function deriveConversationTimes(mapping: Record<string, MessageNode>): { create: number; update: number } {
    let create = Number.POSITIVE_INFINITY;
    let update = 0;

    for (const node of Object.values(mapping)) {
        const message = node.message;
        if (!message) {
            continue;
        }
        const createTime = normalizeNumber(message.create_time);
        const updateTime = normalizeNumber(message.update_time);
        if (createTime !== null) {
            create = Math.min(create, createTime);
            update = Math.max(update, createTime);
        }
        if (updateTime !== null) {
            update = Math.max(update, updateTime);
        }
    }

    const now = Math.floor(Date.now() / 1000);
    const normalizedCreate = Number.isFinite(create) ? create : now;
    const normalizedUpdate = update > 0 ? update : normalizedCreate;
    return { create: normalizedCreate, update: normalizedUpdate };
}

function normalizeConversationCandidate(candidate: unknown): ConversationData | null {
    if (!isRecord(candidate)) {
        return null;
    }

    const mappingValue = candidate.mapping;
    if (!isRecord(mappingValue)) {
        return null;
    }

    const conversationId = normalizeConversationId(candidate);
    if (!conversationId) {
        return null;
    }

    const mapping = mappingValue as Record<string, MessageNode>;
    if (!mapping.root) {
        mapping.root = {
            id: 'root',
            message: null,
            parent: null,
            children: [],
        };
    }

    const times = deriveConversationTimes(mapping);
    const currentNodeCandidate = normalizeText(candidate.current_node);
    const currentNode =
        currentNodeCandidate && mapping[currentNodeCandidate] ? currentNodeCandidate : deriveCurrentNode(mapping);
    const normalizedTitle = normalizeConversationTitle(candidate.title, mapping);

    return {
        title: normalizedTitle,
        create_time: normalizeNumber(candidate.create_time) ?? times.create,
        update_time: normalizeNumber(candidate.update_time) ?? times.update,
        mapping,
        conversation_id: conversationId,
        current_node: currentNode,
        moderation_results: Array.isArray(candidate.moderation_results) ? candidate.moderation_results : [],
        plugin_ids: Array.isArray(candidate.plugin_ids)
            ? candidate.plugin_ids.filter((item): item is string => typeof item === 'string')
            : null,
        gizmo_id: normalizeText(candidate.gizmo_id),
        gizmo_type: normalizeText(candidate.gizmo_type),
        is_archived: candidate.is_archived === true,
        default_model_slug:
            normalizeModelSlug(candidate.default_model_slug) ?? extractMappingModelSlug(mapping) ?? 'unknown',
        safe_urls: Array.isArray(candidate.safe_urls)
            ? candidate.safe_urls.filter((item): item is string => typeof item === 'string')
            : [],
        blocked_urls: Array.isArray(candidate.blocked_urls)
            ? candidate.blocked_urls.filter((item): item is string => typeof item === 'string')
            : [],
    };
}

function tryParseJson(text: string): unknown | null {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function extractSsePayloads(text: string): unknown[] {
    if (!text.includes('data:')) {
        return [];
    }

    const payloads: unknown[] = [];
    const blocks = text.split(/\r?\n\r?\n/);
    for (const block of blocks) {
        const lines = block.split(/\r?\n/);
        const joined = lines
            .map((line) => {
                const match = line.match(/^\s*data:\s?(.*)$/);
                return match ? match[1] : null;
            })
            .filter((line): line is string => typeof line === 'string')
            .join('\n')
            .trim();

        if (!joined || joined === '[DONE]') {
            continue;
        }

        const parsed = tryParseJson(joined);
        if (parsed !== null) {
            payloads.push(parsed);
        }
    }
    return payloads;
}

function normalizeContentType(value: unknown): MessageContent['content_type'] {
    switch (value) {
        case 'thoughts':
        case 'reasoning_recap':
        case 'code':
        case 'execution_output':
            return value;
        default:
            return 'text';
    }
}

function normalizeMessageContent(value: unknown): MessageContent {
    if (!isRecord(value)) {
        return {
            content_type: 'text',
            parts: [],
        };
    }

    const contentType = normalizeContentType(value.content_type);
    const parts = Array.isArray(value.parts)
        ? value.parts.filter((part): part is string => typeof part === 'string')
        : [];

    const thoughts = Array.isArray(value.thoughts)
        ? value.thoughts
              .filter((thought) => isRecord(thought))
              .map((thought) => ({
                  summary: normalizeText(thought.summary) ?? '',
                  content: normalizeText(thought.content) ?? '',
                  chunks: Array.isArray(thought.chunks)
                      ? thought.chunks.filter((chunk): chunk is string => typeof chunk === 'string')
                      : [],
                  finished: thought.finished === true,
              }))
        : undefined;

    return {
        content_type: contentType,
        parts: parts.length > 0 ? parts : undefined,
        thoughts,
        content: normalizeText(value.content) ?? undefined,
    };
}

function normalizeAuthorRole(value: unknown): 'system' | 'user' | 'assistant' | 'tool' {
    if (value === 'system' || value === 'user' || value === 'assistant' || value === 'tool') {
        return value;
    }
    return 'assistant';
}

function normalizeMessage(rawMessage: unknown): Message | null {
    if (!isRecord(rawMessage)) {
        return null;
    }

    const messageId = normalizeText(rawMessage.id);
    if (!messageId) {
        return null;
    }

    const authorValue = isRecord(rawMessage.author) ? rawMessage.author : {};

    const statusRaw = normalizeText(rawMessage.status);
    const status: Message['status'] =
        statusRaw === 'in_progress' || statusRaw === 'error' ? statusRaw : 'finished_successfully';

    const endTurn = typeof rawMessage.end_turn === 'boolean' ? rawMessage.end_turn : null;
    const weight = normalizeNumber(rawMessage.weight) ?? 1;

    return {
        id: messageId,
        author: {
            role: normalizeAuthorRole(authorValue.role),
            name: normalizeText(authorValue.name),
            metadata: isRecord(authorValue.metadata) ? authorValue.metadata : {},
        },
        create_time: normalizeNumber(rawMessage.create_time),
        update_time: normalizeNumber(rawMessage.update_time),
        content: normalizeMessageContent(rawMessage.content),
        status,
        end_turn: endTurn,
        weight,
        metadata: isRecord(rawMessage.metadata) ? rawMessage.metadata : {},
        recipient: normalizeText(rawMessage.recipient) ?? 'all',
        channel: normalizeText(rawMessage.channel),
    };
}

function extractConversationIdFromEvent(event: Record<string, unknown>): string | null {
    const candidates = [
        event.conversation_id,
        event.conversationId,
        isRecord(event.conversation) ? event.conversation.id : null,
        isRecord(event.message) ? (event.message as Record<string, unknown>).conversation_id : null,
        isRecord(event.message) ? (event.message as Record<string, unknown>).conversationId : null,
    ];

    for (const candidate of candidates) {
        const normalized = normalizeText(candidate);
        if (normalized && CONVERSATION_ID_PATTERN.test(normalized)) {
            return normalized;
        }
    }
    return null;
}

function updateMessageTiming(message: Message, stats: { create: number; update: number }): void {
    const messageCreate = normalizeNumber(message.create_time);
    const messageUpdate = normalizeNumber(message.update_time);
    if (messageCreate !== null) {
        stats.create = Math.min(stats.create, messageCreate);
        stats.update = Math.max(stats.update, messageCreate);
    }
    if (messageUpdate !== null) {
        stats.update = Math.max(stats.update, messageUpdate);
    }
}

function extractMessageModelSlug(message: Message): string | null {
    return (
        normalizeModelSlug(message.metadata.resolved_model_slug) ||
        normalizeModelSlug(message.metadata.model_slug) ||
        normalizeModelSlug(message.metadata.model)
    );
}

function appendMessageToMapping(
    mapping: Record<string, MessageNode>,
    previousId: string,
    messageId: string,
    message: Message,
): string {
    mapping[messageId] = {
        id: messageId,
        message,
        parent: previousId,
        children: [],
    };
    mapping[previousId]?.children.push(messageId);
    return messageId;
}

function collectSseMessages(payloads: unknown[]): {
    directConversation: ConversationData | null;
    conversationId: string | null;
    title: string;
    messageOrder: string[];
    messagesById: Map<string, Message>;
} {
    let conversationId: string | null = null;
    let title = '';
    const messageOrder: string[] = [];
    const messagesById = new Map<string, Message>();

    for (const payload of payloads) {
        const directConversation = normalizeConversationCandidate(getConversationCandidate(payload));
        if (directConversation) {
            return {
                directConversation,
                conversationId: null,
                title: '',
                messageOrder: [],
                messagesById: new Map<string, Message>(),
            };
        }

        if (!isRecord(payload)) {
            continue;
        }

        if (!conversationId) {
            conversationId = extractConversationIdFromEvent(payload);
        }

        if (!title) {
            title = normalizeText(payload.conversation_title) ?? normalizeText(payload.title) ?? '';
        }

        const normalizedMessage = normalizeMessage(payload.message);
        if (!normalizedMessage) {
            continue;
        }

        if (!messagesById.has(normalizedMessage.id)) {
            messageOrder.push(normalizedMessage.id);
        }
        messagesById.set(normalizedMessage.id, normalizedMessage);
    }

    return {
        directConversation: null,
        conversationId,
        title,
        messageOrder,
        messagesById,
    };
}

function buildConversationFromSsePayload(payloads: unknown[]): ConversationData | null {
    const extracted = collectSseMessages(payloads);
    if (extracted.directConversation) {
        return extracted.directConversation;
    }

    const { conversationId, title, messageOrder, messagesById } = extracted;
    if (!conversationId || messageOrder.length === 0) {
        return null;
    }

    const mapping: Record<string, MessageNode> = {
        root: {
            id: 'root',
            message: null,
            parent: null,
            children: [],
        },
    };

    let previousId = 'root';
    const timing = { create: Number.POSITIVE_INFINITY, update: 0 };
    let modelSlug: string | null = null;

    for (const messageId of messageOrder) {
        const message = messagesById.get(messageId);
        if (!message) {
            continue;
        }

        previousId = appendMessageToMapping(mapping, previousId, messageId, message);
        updateMessageTiming(message, timing);
        const messageModel = extractMessageModelSlug(message);
        if (messageModel) {
            modelSlug = messageModel;
        }
    }

    const now = Math.floor(Date.now() / 1000);
    const normalizedCreate = Number.isFinite(timing.create) ? timing.create : now;
    const normalizedUpdate = timing.update > 0 ? timing.update : normalizedCreate;

    return {
        title: normalizeConversationTitle(title, mapping),
        create_time: normalizedCreate,
        update_time: normalizedUpdate,
        mapping,
        conversation_id: conversationId,
        current_node: previousId,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: modelSlug ?? 'unknown',
        safe_urls: [],
        blocked_urls: [],
    };
}

function deriveTitleFromFirstUserMessage(mapping: Record<string, MessageNode>): string {
    const userMessage = Object.values(mapping)
        .map((node) => node.message)
        .find((message) => !!message && message.author.role === 'user');
    if (!userMessage) {
        return '';
    }

    const parts = userMessage.content.parts ?? [];
    const raw = parts
        .filter((part) => typeof part === 'string')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) {
        return '';
    }

    const maxLength = 80;
    if (raw.length <= maxLength) {
        return raw;
    }
    return `${raw.slice(0, maxLength - 3).trim()}...`;
}

function isPlaceholderTitle(title: string): boolean {
    const normalized = title.trim();
    if (normalized.length === 0) {
        return true;
    }
    return PLACEHOLDER_TITLE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizeConversationTitle(title: unknown, mapping: Record<string, MessageNode>): string {
    const normalized = normalizeText(title) ?? '';
    if (!isPlaceholderTitle(normalized)) {
        return normalized;
    }
    const derived = deriveTitleFromFirstUserMessage(mapping);
    return derived || normalized;
}

function getMessageTimestamp(message: Message): number {
    return normalizeNumber(message.update_time) ?? normalizeNumber(message.create_time) ?? 0;
}

function collectAssistantMessages(mapping: Record<string, MessageNode>): Message[] {
    const assistantMessages = Object.values(mapping)
        .map((node) => node.message)
        .filter(
            (message): message is NonNullable<(typeof mapping)[string]['message']> =>
                !!message && message.author.role === 'assistant',
        );
    assistantMessages.sort((left, right) => getMessageTimestamp(left) - getMessageTimestamp(right));
    return assistantMessages;
}

function extractAssistantText(message: Message): string {
    const partsText = Array.isArray(message.content.parts)
        ? message.content.parts.filter((part): part is string => typeof part === 'string').join('')
        : '';
    const contentText = normalizeText(message.content.content) ?? '';
    return [partsText, contentText]
        .filter((value) => value.length > 0)
        .join('\n')
        .trim()
        .normalize('NFC');
}

function hasFinishedAssistantText(message: Message): boolean {
    if (message.status !== 'finished_successfully') {
        return false;
    }
    if (message.content.content_type !== 'text') {
        return false;
    }
    return extractAssistantText(message).length > 0;
}

function evaluateChatGPTReadiness(data: ConversationData): PlatformReadiness {
    const assistantMessages = collectAssistantMessages(data.mapping);
    if (assistantMessages.length === 0) {
        return {
            ready: false,
            terminal: false,
            reason: 'assistant-missing',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    const terminal = !assistantMessages.some((message) => message.status === 'in_progress');
    if (!terminal) {
        return {
            ready: false,
            terminal: false,
            reason: 'assistant-in-progress',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    const finishedTextMessages = assistantMessages.filter(hasFinishedAssistantText);
    const latestFinishedText = finishedTextMessages[finishedTextMessages.length - 1];
    if (!latestFinishedText) {
        return {
            ready: false,
            terminal: true,
            reason: 'assistant-text-missing',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    if (!finishedTextMessages.some((message) => message.end_turn === true)) {
        return {
            ready: false,
            terminal: true,
            reason: 'assistant-text-not-terminal-turn',
            contentHash: null,
            latestAssistantTextLength: extractAssistantText(latestFinishedText).length,
        };
    }

    const latestText = extractAssistantText(latestFinishedText);
    return {
        ready: true,
        terminal: true,
        reason: 'terminal',
        contentHash: latestText.length > 0 ? hashText(latestText) : null,
        latestAssistantTextLength: latestText.length,
    };
}

/**
 * Create a ChatGPT Platform Adapter instance.
 *
 * Supports both chatgpt.com and legacy chat.openai.com domains.
 * Handles standard /c/{id} format and gizmo /g/{gizmo}/c/{id} format.
 */
export const createChatGPTAdapter = (): LLMPlatform => {
    /**
     * Maximum length for the title portion of a filename
     */
    const maxTitleLength = 80;

    return {
        name: 'ChatGPT',

        urlMatchPattern: 'https://chatgpt.com/*',

        /**
         * Matches the GET endpoint for fetching full conversation JSON.
         * Format: backend-api/conversation/{uuid}
         */
        apiEndpointPattern:
            /(?:backend-api\/conversation\/[a-f0-9-]+(?:\/)?(?:\?.*)?$|backend-api\/f\/conversation(?:\/[a-f0-9-]+)?(?:\/)?(?:\?.*)?$)/i,
        completionTriggerPattern: /backend-api\/(?:f\/)?conversation\/[a-f0-9-]+\/stream_status(?:\?.*)?$/i,

        /**
         * Check if a URL belongs to ChatGPT
         */
        isPlatformUrl: (url: string) => url.includes('chatgpt.com') || url.includes('chat.openai.com'),

        /**
         * Extract conversation ID from ChatGPT URL
         *
         * Supports:
         * - https://chatgpt.com/c/{uuid}
         * - https://chatgpt.com/g/{gizmo-id}/c/{uuid}
         * - https://chat.openai.com/c/{uuid} (legacy)
         * - URLs with query parameters
         *
         * @param url - The current page URL
         * @returns The conversation UUID or null if not found/invalid
         */
        extractConversationId(url: string): string | null {
            let hostname: string | null = null;
            let pathname = '';

            if (typeof URL !== 'undefined') {
                try {
                    const urlObj = new URL(url);
                    hostname = urlObj.hostname;
                    pathname = urlObj.pathname;
                } catch {
                    return null;
                }
            } else {
                const match = url.match(/^https?:\/\/([^/]+)(\/[^?#]*)?/i);
                if (!match) {
                    return null;
                }
                hostname = match[1];
                pathname = match[2] ?? '';
            }

            // Validate strict hostname
            if (hostname !== 'chatgpt.com' && hostname !== 'chat.openai.com') {
                return null;
            }

            // Look for /c/{uuid} pattern in the pathname
            const pathMatch = pathname.match(/\/c\/([a-f0-9-]+)/i);
            if (!pathMatch) {
                return null;
            }

            const potentialId = pathMatch[1];

            // Validate it's a proper UUID format
            if (!CONVERSATION_ID_PATTERN.test(potentialId)) {
                return null;
            }

            return potentialId;
        },

        extractConversationIdFromUrl(url: string): string | null {
            const match = url.match(/\/backend-api\/(?:f\/)?conversation\/([a-f0-9-]+)\/stream_status/i);
            if (!match?.[1]) {
                return null;
            }
            return CONVERSATION_ID_PATTERN.test(match[1]) ? match[1] : null;
        },

        buildApiUrl(conversationId: string): string {
            return `https://chatgpt.com/backend-api/conversation/${conversationId}`;
        },

        buildApiUrls(conversationId: string): string[] {
            const paths = [`/backend-api/conversation/${conversationId}`];
            return HOST_CANDIDATES.flatMap((host) => paths.map((path) => `${host}${path}`));
        },

        /**
         * Parse intercepted ChatGPT API response
         *
         * @param data - Raw text or parsed object
         * @param _url - The API endpoint URL
         * @returns Validated ConversationData or null
         */
        parseInterceptedData(data: string | any, _url: string): ConversationData | null {
            try {
                const parsed = typeof data === 'string' ? tryParseJson(data) : data;
                const directCandidate = normalizeConversationCandidate(getConversationCandidate(parsed));
                if (directCandidate) {
                    return directCandidate;
                }

                if (typeof data === 'string') {
                    const ssePayloads = extractSsePayloads(data);
                    if (ssePayloads.length > 0) {
                        const sseConversation = buildConversationFromSsePayload(ssePayloads);
                        if (sseConversation) {
                            return sseConversation;
                        }
                    }
                }

                return null;
            } catch (e) {
                logger.error('Failed to parse ChatGPT data:', e);
                return null;
            }
        },

        /**
         * Format a filename for the downloaded JSON
         *
         * Format: {sanitized_title}_{YYYY-MM-DD_HH-MM-SS}
         *
         * @param data - The conversation data
         * @returns A sanitized filename (without .json extension)
         */
        formatFilename(data: ConversationData): string {
            let title = data.title || '';

            if (isPlaceholderTitle(title)) {
                title = deriveTitleFromFirstUserMessage(data.mapping);
            }

            // If still no title, use a default with part of conversation ID
            if (!title.trim()) {
                title = `conversation_${data.conversation_id.slice(0, 8)}`;
            }

            // Sanitize and truncate title
            let sanitizedTitle = sanitizeFilename(title);
            if (sanitizedTitle.length > maxTitleLength) {
                sanitizedTitle = sanitizedTitle.slice(0, maxTitleLength);
            }

            // Generate timestamp from update_time or create_time
            const timestamp = generateTimestamp(data.update_time || data.create_time);

            return `${sanitizedTitle}_${timestamp}`;
        },

        /**
         * Find injection target in ChatGPT UI
         */
        getButtonInjectionTarget(): HTMLElement | null {
            const selectors = [
                '[data-testid="model-switcher-dropdown-button"]',
                'header nav',
                '.flex.items-center.justify-between',
                'header .flex',
            ];

            for (const selector of selectors) {
                const target = document.querySelector(selector);
                if (target) {
                    return (target.parentElement || target) as HTMLElement;
                }
            }
            return null;
        },

        evaluateReadiness(data: ConversationData) {
            return evaluateChatGPTReadiness(data);
        },
    };
};

/**
 * ChatGPT Platform Adapter singleton instance.
 */
export const chatGPTAdapter: LLMPlatform = createChatGPTAdapter();
