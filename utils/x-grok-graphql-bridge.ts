export const X_GROK_GRAPHQL_CONTEXT_REQUEST_MESSAGE = 'BLACKIYA_X_GROK_GRAPHQL_CONTEXT_REQUEST';
export const X_GROK_GRAPHQL_CONTEXT_RESPONSE_MESSAGE = 'BLACKIYA_X_GROK_GRAPHQL_CONTEXT_RESPONSE';

export type XGrokGraphqlContext = {
    queryId?: string;
    features?: string;
    fieldToggles?: string;
    updatedAt: number;
};

export type XGrokGraphqlContextRequestMessage = {
    type: typeof X_GROK_GRAPHQL_CONTEXT_REQUEST_MESSAGE;
    requestId: string;
    __blackiyaToken?: string;
};

export type XGrokGraphqlContextResponseMessage = {
    type: typeof X_GROK_GRAPHQL_CONTEXT_RESPONSE_MESSAGE;
    requestId: string;
    context?: XGrokGraphqlContext;
    __blackiyaToken?: string;
};

export const isXGrokGraphqlContextRequestMessage = (value: unknown): value is XGrokGraphqlContextRequestMessage => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const typed = value as Partial<XGrokGraphqlContextRequestMessage>;
    return (
        typed.type === X_GROK_GRAPHQL_CONTEXT_REQUEST_MESSAGE &&
        typeof typed.requestId === 'string' &&
        typed.requestId.length > 0
    );
};

export const isXGrokGraphqlContextResponseMessage = (value: unknown): value is XGrokGraphqlContextResponseMessage => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const typed = value as Partial<XGrokGraphqlContextResponseMessage>;
    return (
        typed.type === X_GROK_GRAPHQL_CONTEXT_RESPONSE_MESSAGE &&
        typeof typed.requestId === 'string' &&
        typed.requestId.length > 0
    );
};
