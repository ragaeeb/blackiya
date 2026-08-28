import { parseMetaConversationPayload } from './parser';

type ScriptText = { textContent: string | null };

const PUSH_PREFIX = 'self.__next_f.push(';

export const extractMetaNextFlightConversation = (
    scripts: Iterable<ScriptText>,
    expectedConversationId: string,
    maxBytes: number,
): { conversationId: string; responseText: string } | null => {
    for (const script of scripts) {
        const text = script.textContent?.trim();
        if (
            !text?.startsWith(PUSH_PREFIX) ||
            !text.endsWith(')') ||
            text.length > maxBytes ||
            new TextEncoder().encode(text).byteLength > maxBytes
        ) {
            continue;
        }
        try {
            const push = JSON.parse(text.slice(PUSH_PREFIX.length, -1)) as unknown;
            if (!Array.isArray(push) || typeof push[1] !== 'string') {
                continue;
            }
            const jsonStart = push[1].indexOf('{');
            if (jsonStart < 0) {
                continue;
            }
            const responseText = push[1].slice(jsonStart);
            const parsed = parseMetaConversationPayload(responseText);
            if (parsed?.conversation_id === expectedConversationId) {
                return { conversationId: expectedConversationId, responseText };
            }
        } catch {}
    }
    return null;
};
