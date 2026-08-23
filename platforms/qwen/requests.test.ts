import { describe, expect, it } from 'bun:test';
import { QWEN_FIXTURE_CONVERSATION_ID } from './fixtures/conversation-detail';
import {
    buildQwenCompletionRequest,
    buildQwenConversationDetailRequest,
    buildQwenConversationDetailUrl,
    buildQwenConversationListRequest,
    buildQwenConversationListUrl,
    extractQwenRequestContext,
    isQwenCompletionEndpoint,
} from './requests';

const SYNTHETIC_CONTEXT_HEADERS = {
    'bx-umidtoken': 'synthetic-context-value',
    'bx-ua': 'synthetic-client-context',
    'bx-v': 'synthetic-version-context',
    source: 'synthetic-source',
    timezone: 'Synthetic/Timezone',
    version: 'synthetic-version',
};

describe('Qwen request helpers', () => {
    it('should build the HAR-derived complete-history detail URL', () => {
        expect(buildQwenConversationDetailUrl(QWEN_FIXTURE_CONVERSATION_ID)).toBe(
            `https://chat.qwen.ai/api/v2/chats/${QWEN_FIXTURE_CONVERSATION_ID}?direction=up&limit=10`,
        );
        expect(buildQwenConversationDetailUrl('not-a-uuid')).toBeNull();
    });

    it('should extract only bounded Qwen request context and require the anti-bot context field', () => {
        const context = extractQwenRequestContext({
            ...SYNTHETIC_CONTEXT_HEADERS,
            cookie: 'must-not-cross',
            authorization: 'must-not-cross',
            'x-request-id': 'must-not-be-replayed',
            'x-unrelated': 'must-not-cross',
        });

        expect(context).toEqual({ headers: SYNTHETIC_CONTEXT_HEADERS });
        expect(extractQwenRequestContext({ 'bx-ua': 'missing-required-context' })).toBeNull();
    });

    it('should build a same-origin credentialed detail request without mutating context', () => {
        const context = extractQwenRequestContext(SYNTHETIC_CONTEXT_HEADERS)!;
        const before = structuredClone(context);
        const request = buildQwenConversationDetailRequest(QWEN_FIXTURE_CONVERSATION_ID, context);

        expect(request).toEqual({
            url: `https://chat.qwen.ai/api/v2/chats/${QWEN_FIXTURE_CONVERSATION_ID}?direction=up&limit=10`,
            method: 'GET',
            credentials: 'include',
            headers: SYNTHETIC_CONTEXT_HEADERS,
        });
        expect(context).toEqual(before);
        expect(buildQwenConversationDetailRequest('not-a-uuid', context)).toBeNull();
    });

    it('should build and parse the HAR-derived conversation-list request shape', () => {
        expect(buildQwenConversationListUrl({ page: 1, excludeProject: true })).toBe(
            'https://chat.qwen.ai/api/v2/chats/?page=1&exclude_project=true',
        );
        const context = extractQwenRequestContext(SYNTHETIC_CONTEXT_HEADERS)!;
        expect(buildQwenConversationListRequest({ page: 2, excludeProject: false }, context)).toEqual({
            url: 'https://chat.qwen.ai/api/v2/chats/?page=2&exclude_project=false',
            method: 'GET',
            credentials: 'include',
            headers: SYNTHETIC_CONTEXT_HEADERS,
        });
    });

    it('should classify and build the POST completion request locally for future shared integration', () => {
        const context = extractQwenRequestContext(SYNTHETIC_CONTEXT_HEADERS)!;
        const body = {
            chat_id: QWEN_FIXTURE_CONVERSATION_ID,
            chatId: QWEN_FIXTURE_CONVERSATION_ID,
            messages: [{ role: 'user', content: 'Synthetic request content.' }],
            stream: true,
            incremental_output: true,
        };
        const request = buildQwenCompletionRequest({
            conversationId: QWEN_FIXTURE_CONVERSATION_ID,
            body,
            context,
        });

        expect(isQwenCompletionEndpoint(request?.url ?? '', request?.method ?? '')).toBeTrue();
        expect(isQwenCompletionEndpoint('https://chat.qwen.ai/api/v2/chat/completions', 'GET')).toBeFalse();
        expect(isQwenCompletionEndpoint('https://example.com/api/v2/chat/completions', 'POST')).toBeFalse();
        expect(request).toEqual({
            url: `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${QWEN_FIXTURE_CONVERSATION_ID}`,
            method: 'POST',
            credentials: 'include',
            headers: { ...SYNTHETIC_CONTEXT_HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        expect(buildQwenCompletionRequest({ conversationId: 'not-a-uuid', body, context })).toBeNull();
    });
});
