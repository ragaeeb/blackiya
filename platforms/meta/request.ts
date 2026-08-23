export const META_GRAPHQL_ENDPOINT = 'https://www.meta.ai/api/graphql';

const META_CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const META_DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_CURSOR_LENGTH = 4096;
const MAX_PAGE_SIZE = 100;

export type MetaGraphqlRequestContext = {
    documentId: string;
};

export type MetaGraphqlRequest = {
    url: typeof META_GRAPHQL_ENDPOINT;
    method: 'POST';
    headers: { 'content-type': 'application/json' };
    credentials: 'include';
    body: string;
};

export type MetaGraphqlContextCandidate = {
    kind: 'conversation-detail' | 'conversation-pagination';
    documentId: string;
};

type MetaPaginationInput = {
    conversationId: string;
    before: string;
    last: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

export const isMetaConversationId = (value: string): boolean => META_CONVERSATION_ID_PATTERN.test(value);

const isDocumentId = (value: unknown): value is string =>
    typeof value === 'string' && META_DOCUMENT_ID_PATTERN.test(value);

const hasControlCharacter = (value: string): boolean => {
    for (const character of value) {
        const codePoint = character.charCodeAt(0);
        if (codePoint <= 0x1f || codePoint === 0x7f) {
            return true;
        }
    }
    return false;
};

const isCursor = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= MAX_CURSOR_LENGTH && !hasControlCharacter(value);

const isPageSize = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_PAGE_SIZE;

const createRequest = (documentId: string, variables: Record<string, unknown>): MetaGraphqlRequest => ({
    url: META_GRAPHQL_ENDPOINT,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ doc_id: documentId, variables }),
});

export const buildMetaConversationDetailRequest = (
    conversationId: string,
    context: MetaGraphqlRequestContext,
): MetaGraphqlRequest | null => {
    if (!isMetaConversationId(conversationId) || !isDocumentId(context.documentId)) {
        return null;
    }

    return createRequest(context.documentId, {
        id: conversationId,
        includeMessageList: true,
    });
};

export const buildMetaConversationPaginationRequest = (
    input: MetaPaginationInput,
    context: MetaGraphqlRequestContext,
): MetaGraphqlRequest | null => {
    if (
        !isMetaConversationId(input.conversationId) ||
        !isCursor(input.before) ||
        !isPageSize(input.last) ||
        !isDocumentId(context.documentId)
    ) {
        return null;
    }

    return createRequest(context.documentId, {
        before: input.before,
        conversationId: input.conversationId,
        last: input.last,
    });
};

export const extractMetaGraphqlRequestContext = (body: string): MetaGraphqlContextCandidate | null => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return null;
    }

    if (!isRecord(parsed) || !isDocumentId(parsed.doc_id) || !isRecord(parsed.variables)) {
        return null;
    }

    const variables = parsed.variables;
    if (
        variables.includeMessageList === true &&
        typeof variables.id === 'string' &&
        isMetaConversationId(variables.id)
    ) {
        return { kind: 'conversation-detail', documentId: parsed.doc_id };
    }

    if (
        typeof variables.conversationId === 'string' &&
        isMetaConversationId(variables.conversationId) &&
        isCursor(variables.before) &&
        isPageSize(variables.last)
    ) {
        return { kind: 'conversation-pagination', documentId: parsed.doc_id };
    }

    return null;
};
