/**
 * ID patterns and URL/endpoint utilities for the Grok adapter.
 */

/** Numeric Grok streaming conversation IDs (10–20 digits). */
export const GROK_STREAM_CONVERSATION_ID_PATTERN = /^\d{10,20}$/;

/** UUID v4 — grok.com conversation IDs */
export const GROK_COM_CONVERSATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

const GROK_COM_ORIGIN = 'https://grok.com';

const parseGrokComUrl = (url: string): URL | null => {
    try {
        const parsed = new URL(url);
        return parsed.origin === GROK_COM_ORIGIN &&
            parsed.username === '' &&
            parsed.password === '' &&
            parsed.hash === ''
            ? parsed
            : null;
    } catch {
        return null;
    }
};

const hasPermittedQuery = (url: URL, permitted: Readonly<Record<string, string>>) => {
    const names = [...url.searchParams.keys()];
    if (new Set(names).size !== names.length || names.some((name) => !(name in permitted))) {
        return false;
    }
    return names.every((name) => url.searchParams.get(name) === permitted[name]);
};

const extractIdForPath = (pathname: string, prefix: string, suffix = '') => {
    if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
        return null;
    }
    const end = suffix.length > 0 ? -suffix.length : undefined;
    const id = pathname.slice(prefix.length, end);
    return id.length > 0 && !id.includes('/') && GROK_COM_CONVERSATION_ID_PATTERN.test(id) ? id : null;
};

export const isGrokComMetaEndpoint = (url: string) => {
    const parsed = parseGrokComUrl(url);
    return (
        !!parsed &&
        !!extractIdForPath(parsed.pathname, '/rest/app-chat/conversations_v2/') &&
        hasPermittedQuery(parsed, { includeWorkspaces: 'true', includeTaskResult: 'true' })
    );
};

export const isGrokComResponseNodesEndpoint = (url: string) => {
    const parsed = parseGrokComUrl(url);
    return (
        !!parsed &&
        !!extractIdForPath(parsed.pathname, '/rest/app-chat/conversations/', '/response-node') &&
        hasPermittedQuery(parsed, { includeThreads: 'true' })
    );
};

export const isGrokComLoadResponsesEndpoint = (url: string) => {
    const parsed = parseGrokComUrl(url);
    return (
        !!parsed &&
        !!extractIdForPath(parsed.pathname, '/rest/app-chat/conversations/', '/load-responses') &&
        hasPermittedQuery(parsed, {})
    );
};

export const isGrokComReconnectResponseEndpoint = (url: string) => {
    const parsed = parseGrokComUrl(url);
    return (
        !!parsed &&
        !!extractIdForPath(parsed.pathname, '/rest/app-chat/conversations/reconnect-response-v2/') &&
        hasPermittedQuery(parsed, {})
    );
};

/** Extract a grok.com UUID conversation ID from a REST URL path. */
export const extractGrokComConversationIdFromUrl = (url: string): string | null => {
    const parsed = parseGrokComUrl(url);
    if (!parsed) {
        return null;
    }
    return (
        extractIdForPath(parsed.pathname, '/rest/app-chat/conversations_v2/') ??
        extractIdForPath(parsed.pathname, '/rest/app-chat/conversations/', '/response-node') ??
        extractIdForPath(parsed.pathname, '/rest/app-chat/conversations/', '/load-responses')
    );
};
