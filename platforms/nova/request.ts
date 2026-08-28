import { NOVA_API_URL, NOVA_CONVERSATION_DETAIL_TARGET, NOVA_CONVERSATION_ID_PATTERN, NOVA_ORIGIN } from './constants';

export type NovaConversationRequestContext = {
    conversationId: string;
    traceId: string;
    userType: string;
    antiCsrfTokenA2z: string;
    amzContentSha256: string;
    amzDate: string;
    amzSecurityToken: string;
    amzSessionId: string;
    sdkInvocationId?: string;
    sdkRequest?: string;
};

export type NovaConversationRequest = {
    url: typeof NOVA_API_URL;
    method: 'POST';
    headers: Record<string, string>;
    body: string;
};

export type NovaRequestIdentity = {
    url: string;
    method: string;
    target: string | null | undefined;
};

const isNonEmpty = (value: string | undefined): value is string => typeof value === 'string' && value.trim().length > 0;

const isCanonicalNovaApiUrl = (url: string) => {
    try {
        const parsed = new URL(url);
        return (
            parsed.origin === NOVA_ORIGIN && parsed.pathname === '/api' && parsed.search === '' && parsed.hash === ''
        );
    } catch {
        return false;
    }
};

export const isNovaConversationDetailRequest = (request: NovaRequestIdentity) =>
    request.method.toUpperCase() === 'POST' &&
    request.target === NOVA_CONVERSATION_DETAIL_TARGET &&
    isCanonicalNovaApiUrl(request.url);

const hasCompleteContext = (context: NovaConversationRequestContext) =>
    [
        context.traceId,
        context.userType,
        context.antiCsrfTokenA2z,
        context.amzContentSha256,
        context.amzDate,
        context.amzSecurityToken,
        context.amzSessionId,
    ].every(isNonEmpty);

export const buildNovaConversationRequest = (
    conversationId: string,
    context: NovaConversationRequestContext,
): NovaConversationRequest | null => {
    if (
        !NOVA_CONVERSATION_ID_PATTERN.test(conversationId) ||
        context.conversationId !== conversationId ||
        !hasCompleteContext(context)
    ) {
        return null;
    }

    const headers: Record<string, string> = {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': NOVA_CONVERSATION_DETAIL_TARGET,
        'anti-csrftoken-a2z': context.antiCsrfTokenA2z,
        'x-amz-content-sha256': context.amzContentSha256,
        'x-amz-date': context.amzDate,
        'x-amz-security-token': context.amzSecurityToken,
        'x-amz-session-id': context.amzSessionId,
    };
    if (isNonEmpty(context.sdkInvocationId)) {
        headers['amz-sdk-invocation-id'] = context.sdkInvocationId;
    }
    if (isNonEmpty(context.sdkRequest)) {
        headers['amz-sdk-request'] = context.sdkRequest;
    }

    return {
        url: NOVA_API_URL,
        method: 'POST',
        headers,
        body: JSON.stringify({
            conversationId,
            userType: context.userType,
            traceId: context.traceId,
        }),
    };
};
