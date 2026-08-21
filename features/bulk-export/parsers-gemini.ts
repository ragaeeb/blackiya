import { parseBatchexecuteResponse } from '@/utils/google-rpc';
import { uniqueStrings } from './utils';

export const GEMINI_CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9_-]{6,}$/;

export const extractGeminiConversationIdsFromBatchexecuteText = (text: string): string[] => {
    const ids: string[] = [];

    const addMatches = (source: string) => {
        const matcher = /\bc_([a-zA-Z0-9_-]{6,})\b/g;
        for (const match of source.matchAll(matcher)) {
            const conversationId = match[1];
            if (conversationId && GEMINI_CONVERSATION_ID_PATTERN.test(conversationId)) {
                ids.push(conversationId);
            }
        }
    };

    addMatches(text);
    const rpcResults = parseBatchexecuteResponse(text);
    for (const rpc of rpcResults) {
        if (typeof rpc.payload !== 'string') {
            continue;
        }
        addMatches(rpc.payload);
    }

    return uniqueStrings(ids);
};
