import type { ConversationData, Message, MessageNode, RawConversationPayload } from '@/utils/types';
import { isMetaConversationId } from './request';

type JsonRecord = Record<string, unknown>;
type MetaHistoryState = 'complete' | 'incomplete' | 'unknown';

type MetaMessageCandidate = {
    id: string;
    role: 'user' | 'assistant';
    source: JsonRecord;
};

const isRecord = (value: unknown): value is JsonRecord =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

const isJsonValue = (value: unknown): value is RawConversationPayload => {
    if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) {
        return true;
    }
    if (Array.isArray(value)) {
        return value.every(isJsonValue);
    }
    return isRecord(value) && Object.values(value).every(isJsonValue);
};

const parseJsonPayload = (value: unknown): RawConversationPayload | null => {
    if (typeof value !== 'string') {
        return isJsonValue(value) ? value : null;
    }

    const candidates = [value, ...value.split(/\r?\n/)]
        .map((candidate) => candidate.replace(/^for \(;;\);/, '').trim())
        .filter((candidate) => candidate.startsWith('{'));

    for (const candidate of candidates) {
        try {
            const parsed: unknown = JSON.parse(candidate);
            if (isJsonValue(parsed)) {
                return parsed;
            }
        } catch {}
    }

    return null;
};

const getConversation = (payload: RawConversationPayload): JsonRecord | null => {
    if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.conversation)) {
        return null;
    }
    return payload.data.conversation;
};

const getMessages = (conversation: JsonRecord): JsonRecord | null =>
    isRecord(conversation.messages) ? conversation.messages : null;

const getEdges = (conversation: JsonRecord): unknown[] | null => {
    const messages = getMessages(conversation);
    return messages && Array.isArray(messages.edges) ? messages.edges : null;
};

const getPageInfo = (payload: RawConversationPayload): JsonRecord | null => {
    const conversation = getConversation(payload);
    const messages = conversation ? getMessages(conversation) : null;
    return messages && isRecord(messages.pageInfo) ? messages.pageInfo : null;
};

const getMessageRole = (node: JsonRecord): MetaMessageCandidate['role'] | null => {
    const typename = typeof node.__typename === 'string' ? node.__typename : node.__isMessage;
    if (typename === 'UserMessage') {
        return 'user';
    }
    if (typename === 'AssistantMessage') {
        return 'assistant';
    }
    return null;
};

const getMessageCandidates = (conversation: JsonRecord, conversationId: string): MetaMessageCandidate[] | null => {
    const edges = getEdges(conversation);
    if (!edges) {
        return null;
    }

    const candidates: MetaMessageCandidate[] = [];
    for (const edgeValue of edges) {
        if (!isRecord(edgeValue) || !isRecord(edgeValue.node)) {
            return null;
        }

        const node = edgeValue.node;
        const id = typeof node.id === 'string' && node.id.trim().length > 0 ? node.id : null;
        const role = getMessageRole(node);
        if (!id || !role) {
            return null;
        }
        if (typeof node.conversationId === 'string' && node.conversationId !== conversationId) {
            return null;
        }
        candidates.push({ id, role, source: node });
    }

    return candidates;
};

const parseTimestamp = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 10_000_000_000 ? value / 1000 : value;
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
        return null;
    }
    const milliseconds = Date.parse(value);
    return Number.isNaN(milliseconds) ? null : milliseconds / 1000;
};

const getRenderer = (node: JsonRecord): JsonRecord | null =>
    isRecord(node.contentRenderer) ? node.contentRenderer : null;

const getRendererMessage = (node: JsonRecord): JsonRecord | null => {
    const renderer = getRenderer(node);
    return renderer && isRecord(renderer.message) ? renderer.message : null;
};

const getText = (node: JsonRecord, role: MetaMessageCandidate['role']): string => {
    const rendererMessage = getRendererMessage(node);
    const candidates =
        role === 'user'
            ? [node.userContent, node.content, rendererMessage?.content]
            : [node.content, rendererMessage?.content, node.userContent];
    return candidates.find((candidate): candidate is string => typeof candidate === 'string') ?? '';
};

const getStructuredContent = (node: JsonRecord): JsonRecord | null => {
    const renderer = getRenderer(node);
    return renderer && isRecord(renderer.unified_response) ? renderer.unified_response : null;
};

const getStreamingStates = (node: JsonRecord): string[] => {
    const rendererMessage = getRendererMessage(node);
    return [node.streamingState, rendererMessage?.streamingState].filter(
        (value): value is string => typeof value === 'string',
    );
};

const isTerminalAssistant = (node: JsonRecord): boolean => {
    const states = getStreamingStates(node);
    return states.length > 0 && states.every((state) => state === 'DONE');
};

const buildMessage = (candidate: MetaMessageCandidate): Message => {
    const { id, role, source } = candidate;
    const createdAt = parseTimestamp(
        source.createdAt ?? (role === 'assistant' ? source.assistantCreatedAt : source.userCreatedAt),
    );
    const text = getText(source, role);
    const structuredContent = getStructuredContent(source);
    const hasError = source.error !== null && source.error !== undefined;
    const terminal = role === 'assistant' ? isTerminalAssistant(source) : true;
    const parts = text.length > 0 ? [text] : structuredContent ? [structuredContent] : [];

    return {
        id,
        author: {
            role,
            name: role === 'assistant' ? 'Meta AI' : 'User',
            metadata: {},
        },
        create_time: createdAt,
        update_time: createdAt,
        content: {
            content_type: 'text',
            parts,
        },
        status: hasError ? 'error' : terminal ? 'finished_successfully' : 'in_progress',
        end_turn: role === 'assistant' ? terminal : null,
        weight: 1,
        metadata: {
            meta: {
                typename: source.__typename ?? source.__isMessage ?? null,
                streamingStates: getStreamingStates(source),
                hasStructuredContent: structuredContent !== null,
                hasError,
            },
        },
        recipient: 'all',
        channel: null,
    };
};

const buildMapping = (candidates: MetaMessageCandidate[]): Record<string, MessageNode> => {
    const mapping: Record<string, MessageNode> = {};
    for (const [index, candidate] of candidates.entries()) {
        const parent = candidates[index - 1]?.id ?? null;
        const child = candidates[index + 1]?.id;
        mapping[candidate.id] = {
            id: candidate.id,
            message: buildMessage(candidate),
            parent,
            children: child ? [child] : [],
        };
    }
    return mapping;
};

const getCandidateTimestamp = (candidate: MetaMessageCandidate): number | null =>
    parseTimestamp(
        candidate.source.createdAt ??
            (candidate.role === 'assistant' ? candidate.source.assistantCreatedAt : candidate.source.userCreatedAt),
    );

const getArchiveParts = (
    rawPayload: RawConversationPayload | undefined,
): { initial: RawConversationPayload; pages: RawConversationPayload[] } | null => {
    if (!rawPayload || !isRecord(rawPayload)) {
        return null;
    }
    if ('initial_response' in rawPayload || 'pagination_responses' in rawPayload) {
        if (!isJsonValue(rawPayload.initial_response) || !Array.isArray(rawPayload.pagination_responses)) {
            return null;
        }
        const pages = rawPayload.pagination_responses.filter(isJsonValue);
        if (pages.length !== rawPayload.pagination_responses.length) {
            return null;
        }
        return { initial: rawPayload.initial_response, pages };
    }
    return { initial: rawPayload, pages: [] };
};

export const getMetaHistoryState = (data: ConversationData): MetaHistoryState => {
    const archive = getArchiveParts(data.raw_payload);
    if (!archive) {
        return 'unknown';
    }
    const oldestPayload = archive.pages.at(-1) ?? archive.initial;
    const pageInfo = getPageInfo(oldestPayload);
    if (typeof pageInfo?.hasPreviousPage !== 'boolean') {
        return 'unknown';
    }
    return pageInfo.hasPreviousPage ? 'incomplete' : 'complete';
};

export const isMetaConversationPayload = (value: unknown): boolean => {
    const payload = parseJsonPayload(value);
    if (!payload) {
        return false;
    }
    const conversation = getConversation(payload);
    if (!conversation || typeof conversation.id !== 'string' || !isMetaConversationId(conversation.id)) {
        return false;
    }
    if (conversation.type !== undefined && conversation.type !== 'CHAT') {
        return false;
    }
    if (typeof conversation.title !== 'string' && typeof conversation.displayTitle !== 'string') {
        return false;
    }
    return getEdges(conversation) !== null;
};

const parsePaginationPages = (pageValues: unknown[], conversationId: string): RawConversationPayload[] | null => {
    const pages: RawConversationPayload[] = [];
    for (const pageValue of pageValues) {
        const page = parseJsonPayload(pageValue);
        const pageConversation = page ? getConversation(page) : null;
        if (
            !page ||
            !pageConversation ||
            pageConversation.id !== conversationId ||
            getEdges(pageConversation) === null
        ) {
            return null;
        }
        pages.push(page);
    }
    return pages;
};

const collectArchiveCandidates = (
    initialConversation: JsonRecord,
    pages: RawConversationPayload[],
    conversationId: string,
): MetaMessageCandidate[] | null => {
    const pageConversations = pages
        .slice()
        .reverse()
        .map(getConversation)
        .filter((conversation): conversation is JsonRecord => conversation !== null);
    const orderedCandidates = new Map<string, MetaMessageCandidate>();

    for (const conversation of [...pageConversations, initialConversation]) {
        const candidates = getMessageCandidates(conversation, conversationId);
        if (!candidates) {
            return null;
        }
        for (const candidate of candidates) {
            orderedCandidates.delete(candidate.id);
            orderedCandidates.set(candidate.id, candidate);
        }
    }

    return [...orderedCandidates.values()];
};

const buildRawArchivePayload = (
    initial: RawConversationPayload,
    pages: RawConversationPayload[],
): RawConversationPayload =>
    pages.length === 0
        ? initial
        : {
              initial_response: initial,
              pagination_responses: pages,
          };

export const parseMetaConversationArchive = (initialValue: unknown, pageValues: unknown[]): ConversationData | null => {
    const initial = parseJsonPayload(initialValue);
    if (!initial || !isMetaConversationPayload(initial)) {
        return null;
    }
    const initialConversation = getConversation(initial);
    if (!initialConversation || typeof initialConversation.id !== 'string') {
        return null;
    }

    const conversationId = initialConversation.id;
    const pages = parsePaginationPages(pageValues, conversationId);
    if (!pages) {
        return null;
    }
    const candidates = collectArchiveCandidates(initialConversation, pages, conversationId);
    if (!candidates || candidates.length === 0) {
        return null;
    }

    const timestamps = candidates
        .map(getCandidateTimestamp)
        .filter((timestamp): timestamp is number => timestamp !== null);
    const updatedAt = parseTimestamp(initialConversation.updatedAt) ?? Math.max(...timestamps, 0);
    const createTime = timestamps.length > 0 ? Math.min(...timestamps) : updatedAt;
    const titleCandidate =
        typeof initialConversation.title === 'string' ? initialConversation.title : initialConversation.displayTitle;
    const title = typeof titleCandidate === 'string' ? titleCandidate : '';

    return {
        title,
        create_time: createTime,
        update_time: updatedAt,
        mapping: buildMapping(candidates),
        conversation_id: conversationId,
        current_node: candidates.at(-1)!.id,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: 'meta-ai',
        safe_urls: [],
        blocked_urls: [],
        raw_payload: buildRawArchivePayload(initial, pages),
    };
};

export const parseMetaConversationPayload = (value: unknown): ConversationData | null =>
    parseMetaConversationArchive(value, []);
