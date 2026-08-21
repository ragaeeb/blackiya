import { asRecord, firstNonNull, readNestedString, readString, uniqueStrings } from './utils';

export const CHATGPT_CONVERSATION_ID_PATTERN = /^[a-z0-9-]{6,}$/i;

const extractChatGptConversationIdFromItem = (item: unknown): string | null => {
    const record = asRecord(item);
    const candidate = firstNonNull([
        readString(record, 'id'),
        readString(record, 'conversation_id'),
        readNestedString(record, 'conversation', 'id'),
    ]);
    if (!candidate || !CHATGPT_CONVERSATION_ID_PATTERN.test(candidate)) {
        return null;
    }
    return candidate;
};

const collectChatGptConversationArrays = (payload: unknown): unknown[][] => {
    const record = asRecord(payload);
    if (!record) {
        return [];
    }

    const dataRecord = asRecord(record.data);
    const nestedPayloadRecord = asRecord(record.payload);
    const candidates = [
        record.items,
        record.conversations,
        dataRecord?.items,
        dataRecord?.conversations,
        nestedPayloadRecord?.items,
        nestedPayloadRecord?.conversations,
    ];
    return candidates.filter((value): value is unknown[] => Array.isArray(value));
};

export const extractChatGptConversationIdsFromPayload = (payload: unknown): string[] => {
    const ids: string[] = [];
    for (const items of collectChatGptConversationArrays(payload)) {
        for (const item of items) {
            const conversationId = extractChatGptConversationIdFromItem(item);
            if (conversationId) {
                ids.push(conversationId);
            }
        }
    }

    return uniqueStrings(ids);
};

export const extractChatGptConversationIdsFromText = (text: string): string[] => {
    const ids: string[] = [];
    const idPatterns = [
        /"id"\s*:\s*"([a-z0-9-]{6,})"/gi,
        /"conversation_id"\s*:\s*"([a-z0-9-]{6,})"/gi,
        /"conversation"\s*:\s*\{\s*"id"\s*:\s*"([a-z0-9-]{6,})"/gi,
    ];

    for (const pattern of idPatterns) {
        for (const match of text.matchAll(pattern)) {
            const candidate = match[1];
            if (typeof candidate === 'string' && CHATGPT_CONVERSATION_ID_PATTERN.test(candidate)) {
                ids.push(candidate);
            }
        }
    }

    return uniqueStrings(ids);
};
