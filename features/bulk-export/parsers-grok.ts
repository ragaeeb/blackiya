import { asRecord, firstNonNull, parseJsonSafe, readNestedString, readString, uniqueStrings } from './utils';

export const GROK_COM_CONVERSATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

const collectGrokComConversationArrays = (payload: unknown): unknown[][] => {
    const record = asRecord(payload);
    if (!record) {
        return [];
    }

    const dataRecord = asRecord(record.data);
    const candidates = [record.items, record.conversations, dataRecord?.items, dataRecord?.conversations];
    return candidates.filter((value): value is unknown[] => Array.isArray(value));
};

const extractGrokComConversationIdFromItem = (item: unknown): string | null => {
    const record = asRecord(item);
    const candidate = firstNonNull([
        readString(record, 'id'),
        readString(record, 'conversationId'),
        readString(record, 'conversation_id'),
        readString(record, 'rest_id'),
        readNestedString(record, 'conversation', 'id'),
        readNestedString(record, 'grokConversation', 'rest_id'),
    ]);
    if (!candidate || !GROK_COM_CONVERSATION_ID_PATTERN.test(candidate)) {
        return null;
    }
    return candidate;
};

export const extractGrokComConversationIdsFromPayload = (payload: unknown): string[] => {
    const ids: string[] = [];
    for (const collection of collectGrokComConversationArrays(payload)) {
        for (const item of collection) {
            const conversationId = extractGrokComConversationIdFromItem(item);
            if (conversationId) {
                ids.push(conversationId);
            }
        }
    }
    return uniqueStrings(ids);
};

export const extractGrokComConversationIdsFromText = (text: string): string[] => {
    const ids: string[] = [];
    const keyPatterns = [
        /"conversationId"\s*:\s*"([a-f0-9-]{36})"/gi,
        /"conversation_id"\s*:\s*"([a-f0-9-]{36})"/gi,
        /"id"\s*:\s*"([a-f0-9-]{36})"/gi,
        /"conversation"\s*:\s*\{\s*"id"\s*:\s*"([a-f0-9-]{36})"/gi,
    ];
    for (const pattern of keyPatterns) {
        for (const match of text.matchAll(pattern)) {
            const candidate = match[1];
            if (typeof candidate === 'string' && GROK_COM_CONVERSATION_ID_PATTERN.test(candidate)) {
                ids.push(candidate);
            }
        }
    }
    return uniqueStrings(ids);
};

const extractGrokResponseIdsFromNodePayload = (payload: unknown): string[] => {
    const ids: string[] = [];
    const pushId = (value: unknown) => {
        if (typeof value !== 'string') {
            return;
        }
        if (GROK_COM_CONVERSATION_ID_PATTERN.test(value)) {
            ids.push(value);
        }
    };

    const readIdsFromNodeArray = (value: unknown) => {
        if (!Array.isArray(value)) {
            return;
        }
        for (const item of value) {
            const itemRecord = asRecord(item);
            pushId(itemRecord?.responseId);
        }
    };

    const record = asRecord(payload);
    readIdsFromNodeArray(record?.responseNodes);
    readIdsFromNodeArray(record?.inflightResponses);

    return uniqueStrings(ids);
};

export const extractGrokResponseIdsFromNodeText = (text: string): string[] => {
    const parsed = parseJsonSafe(text);
    const fromPayload = extractGrokResponseIdsFromNodePayload(parsed);
    if (fromPayload.length > 0) {
        return fromPayload;
    }

    const ids: string[] = [];
    const pattern = /"responseId"\s*:\s*"([a-f0-9-]{36})"/gi;
    for (const match of text.matchAll(pattern)) {
        const candidate = match[1];
        if (typeof candidate === 'string' && GROK_COM_CONVERSATION_ID_PATTERN.test(candidate)) {
            ids.push(candidate);
        }
    }
    return uniqueStrings(ids);
};
