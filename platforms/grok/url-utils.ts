/**
 * ID patterns and URL/endpoint utilities for the Grok adapter.
 */

/** Numeric string — x.com Grok conversation IDs (10–20 digits) */
export const X_CONVERSATION_ID_PATTERN = /^\d{10,20}$/;

/** UUID v4 — grok.com conversation IDs */
export const GROK_COM_CONVERSATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// ── Endpoint classifiers ───────────────────────────────────────────────────────

export const isGrokComMetaEndpoint = (url: string) => url.includes('/rest/app-chat/conversations_v2/');

export const isGrokComResponseNodesEndpoint = (url: string) =>
    url.includes('/rest/app-chat/conversations/') && url.includes('/response-node');

export const isGrokComLoadResponsesEndpoint = (url: string) =>
    url.includes('/rest/app-chat/conversations/') && url.includes('/load-responses');

export const isXGraphqlEndpoint = (url: string) => url.includes('/i/api/graphql/');

// ── Conversation ID extraction ─────────────────────────────────────────────────

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

/** Extract restId from GraphQL `variables` query-param (JSON or URL-encoded fallback). */
export const extractRestIdFromVariables = (variablesStr: string | null): string | null => {
    if (!variablesStr) {
        return null;
    }
    try {
        const parsed = JSON.parse(variablesStr);
        const restId = parsed?.restId;
        return typeof restId === 'string' ? restId : null;
    } catch {
        const decoded = decodeURIComponent(variablesStr);
        const match = decoded.match(/restId["\\]*\s*:\s*["\\]*(\d+)/);
        return match?.[1] ?? null;
    }
};

/** Extract a numeric x.com conversation ID from a GraphQL API URL. */
export const extractXConversationIdFromApiUrl = (url: string): string | null => {
    try {
        const variablesStr = new URL(url).searchParams.get('variables');
        return extractRestIdFromVariables(variablesStr);
    } catch {
        const match = url.match(/%22restId%22%3A%22(\d+)%22/);
        return match?.[1] ?? null;
    }
};

/**
 * Resolve a conversation ID override from a GraphQL URL, returning `undefined`
 * when the URL is not an x.com GraphQL endpoint (so callers can distinguish
 * "no ID found" from "wrong endpoint type").
 */
export const resolveXGraphqlConversationId = (url: string): string | undefined => {
    if (!url || !isXGraphqlEndpoint(url)) {
        return undefined;
    }
    return extractXConversationIdFromApiUrl(url) || undefined;
};
