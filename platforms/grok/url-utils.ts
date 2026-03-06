/**
 * ID patterns and URL/endpoint utilities for the Grok adapter.
 */

/** Numeric Grok streaming conversation IDs (10–20 digits). */
export const GROK_STREAM_CONVERSATION_ID_PATTERN = /^\d{10,20}$/;

/** UUID v4 — grok.com conversation IDs */
export const GROK_COM_CONVERSATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export const isGrokComMetaEndpoint = (url: string) => url.includes('/rest/app-chat/conversations_v2/');

export const isGrokComResponseNodesEndpoint = (url: string) =>
    url.includes('/rest/app-chat/conversations/') && url.includes('/response-node');

export const isGrokComLoadResponsesEndpoint = (url: string) =>
    url.includes('/rest/app-chat/conversations/') && url.includes('/load-responses');

export const isGrokComReconnectResponseEndpoint = (url: string) =>
    url.includes('/rest/app-chat/conversations/reconnect-response-v2/');

/** Extract a grok.com UUID conversation ID from a REST URL path. */
export const extractGrokComConversationIdFromUrl = (url: string): string | null => {
    try {
        const { pathname } = new URL(url);
        const match = pathname.match(
            /\/rest\/app-chat\/conversations_v2\/([^/]+)|\/rest\/app-chat\/conversations\/([^/]+)/,
        );
        const conversationId = match?.[1] ?? match?.[2] ?? null;
        if (!conversationId) {
            return null;
        }
        return GROK_COM_CONVERSATION_ID_PATTERN.test(conversationId) ? conversationId : null;
    } catch {
        return null;
    }
};
