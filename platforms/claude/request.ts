const CLAUDE_ORIGIN = 'https://claude.ai';
const CLAUDE_CONVERSATION_API_PATH = /^\/api\/organizations\/([^/]+)\/chat_conversations\/([^/]+)\/?$/;
const CLAUDE_CANONICAL_QUERY = {
    tree: 'true',
    rendering_mode: 'messages',
    render_all_tools: 'true',
    consistency: 'strong',
} as const;

export const CLAUDE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ClaudeRequestContext = {
    organizationId: string;
};

export type ClaudeConversationRequest = {
    method: 'GET';
    url: string;
    requiresAuthContext: false;
};

export type ClaudeConversationApiContext = {
    organizationId: string;
    conversationId: string;
};

export const parseClaudeConversationApiUrl = (url: string): ClaudeConversationApiContext | null => {
    try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'claude.ai') {
            return null;
        }

        const match = parsedUrl.pathname.match(CLAUDE_CONVERSATION_API_PATH);
        const organizationId = match?.[1] ?? '';
        const conversationId = match?.[2] ?? '';
        if (!CLAUDE_UUID_PATTERN.test(organizationId) || !CLAUDE_UUID_PATTERN.test(conversationId)) {
            return null;
        }
        const canonicalQueryEntries = Object.entries(CLAUDE_CANONICAL_QUERY);
        const hasCanonicalQuery =
            [...parsedUrl.searchParams.keys()].length === canonicalQueryEntries.length &&
            canonicalQueryEntries.every(
                ([key, value]) =>
                    parsedUrl.searchParams.getAll(key).length === 1 && parsedUrl.searchParams.get(key) === value,
            );
        if (!hasCanonicalQuery) {
            return null;
        }

        return { organizationId, conversationId };
    } catch {
        return null;
    }
};

export const isClaudeConversationDetailRequest = (url: string, method: string): boolean =>
    method.toUpperCase() === 'GET' && parseClaudeConversationApiUrl(url) !== null;

export const buildClaudeConversationRequest = (
    conversationId: string,
    context: ClaudeRequestContext,
): ClaudeConversationRequest | null => {
    if (!CLAUDE_UUID_PATTERN.test(conversationId) || !CLAUDE_UUID_PATTERN.test(context.organizationId)) {
        return null;
    }

    const url = new URL(
        `/api/organizations/${context.organizationId}/chat_conversations/${conversationId}`,
        CLAUDE_ORIGIN,
    );
    for (const [key, value] of Object.entries(CLAUDE_CANONICAL_QUERY)) {
        url.searchParams.set(key, value);
    }

    return {
        method: 'GET',
        url: url.toString(),
        requiresAuthContext: false,
    };
};
