import { buildZaiDetailUrl, buildZaiMessagesBatchUrl, isZaiConversationId } from './constants';

export type ZaiRequestContext = {
    region?: string;
};

export type ZaiDetailRequest = {
    url: string;
    method: 'GET';
    headers?: Record<string, string>;
};

export type ZaiMessagesBatchRequest = {
    url: string;
    method: 'POST';
    headers: Record<string, string>;
    body: string;
};

const toRecord = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const parseRecord = (value: unknown): Record<string, unknown> | null => {
    if (typeof value !== 'string') {
        return toRecord(value);
    }
    try {
        return toRecord(JSON.parse(value));
    } catch {
        return null;
    }
};

const buildContextHeaders = (context: ZaiRequestContext | undefined): Record<string, string> | undefined => {
    const region = context?.region?.trim();
    return region ? { 'x-region': region } : undefined;
};

const readDetailIdentity = (payload: unknown) => {
    const root = parseRecord(payload);
    const chat = toRecord(root?.chat);
    const history = toRecord(chat?.history);
    const messages = toRecord(history?.messages);
    const conversationId = root?.id;
    const currentId = history?.currentId;

    if (
        !root ||
        !chat ||
        !history ||
        !messages ||
        !isZaiConversationId(conversationId) ||
        chat.id !== conversationId ||
        !isZaiConversationId(currentId) ||
        !Object.hasOwn(messages, currentId)
    ) {
        return null;
    }

    return { conversationId, currentId, messages };
};

export const extractZaiMessageIds = (detailPayload: unknown): string[] | null => {
    const identity = readDetailIdentity(detailPayload);
    if (!identity) {
        return null;
    }

    const messageIds = Object.keys(identity.messages);
    if (messageIds.length === 0) {
        return null;
    }
    for (const messageId of messageIds) {
        const message = toRecord(identity.messages[messageId]);
        if (!isZaiConversationId(messageId) || message?.id !== messageId) {
            return null;
        }
    }
    return messageIds;
};

export const buildZaiDetailRequest = (conversationId: string, context?: ZaiRequestContext): ZaiDetailRequest | null => {
    if (!isZaiConversationId(conversationId)) {
        return null;
    }
    const headers = buildContextHeaders(context);
    return {
        url: buildZaiDetailUrl(conversationId),
        method: 'GET',
        ...(headers ? { headers } : {}),
    };
};

export const buildZaiMessagesBatchRequest = (
    detailPayload: unknown,
    context?: ZaiRequestContext,
): ZaiMessagesBatchRequest | null => {
    const identity = readDetailIdentity(detailPayload);
    const ids = extractZaiMessageIds(detailPayload);
    if (!identity || !ids) {
        return null;
    }

    return {
        url: buildZaiMessagesBatchUrl(identity.conversationId),
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(buildContextHeaders(context) ?? {}),
        },
        body: JSON.stringify({ ids }),
    };
};
