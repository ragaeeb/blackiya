import { describe, expect, it } from 'bun:test';
import {
    createCurrentDeepSeekHistoryResponse,
    createSyntheticDeepSeekHistoryResponse,
    SYNTHETIC_DEEPSEEK_CONVERSATION_ID,
    SYNTHETIC_DEEPSEEK_FULL_HISTORY_URL,
    SYNTHETIC_DEEPSEEK_HISTORY_URL,
} from './fixtures/history-response';
import { deepSeekAdapter } from './index';

describe('DeepSeek adapter', () => {
    it('should identify only secure chat.deepseek.com URLs', () => {
        expect(deepSeekAdapter.isPlatformUrl('https://chat.deepseek.com/')).toBeTrue();
        expect(
            deepSeekAdapter.isPlatformUrl(`https://chat.deepseek.com/a/chat/s/${SYNTHETIC_DEEPSEEK_CONVERSATION_ID}`),
        ).toBeTrue();
        expect(deepSeekAdapter.isPlatformUrl('http://chat.deepseek.com/')).toBeFalse();
        expect(deepSeekAdapter.isPlatformUrl('https://chat.deepseek.com.example/')).toBeFalse();
        expect(deepSeekAdapter.isPlatformUrl('not-a-url')).toBeFalse();
    });

    it('should extract the UUID from a conversation page URL', () => {
        expect(
            deepSeekAdapter.extractConversationId(
                `https://chat.deepseek.com/a/chat/s/${SYNTHETIC_DEEPSEEK_CONVERSATION_ID}?source=synthetic#turn`,
            ),
        ).toBe(SYNTHETIC_DEEPSEEK_CONVERSATION_ID);
        expect(deepSeekAdapter.extractConversationId(SYNTHETIC_DEEPSEEK_HISTORY_URL)).toBeNull();
        expect(deepSeekAdapter.extractConversationId('https://chat.deepseek.com/a/chat/s/not-a-uuid')).toBeNull();
        expect(
            deepSeekAdapter.extractConversationId(`https://example.com/a/chat/s/${SYNTHETIC_DEEPSEEK_CONVERSATION_ID}`),
        ).toBeNull();
    });

    it('should expose a contract-compatible deterministic history URL', () => {
        const url = deepSeekAdapter.buildApiUrl?.(SYNTHETIC_DEEPSEEK_CONVERSATION_ID);

        expect(url).toBeDefined();
        if (!url) {
            throw new Error('Expected the DeepSeek adapter to build a history URL.');
        }
        const parsed = new URL(url);
        expect(parsed.origin).toBe('https://chat.deepseek.com');
        expect(parsed.pathname).toBe('/api/v0/chat/history_messages');
        expect(parsed.searchParams.get('chat_session_id')).toBe(SYNTHETIC_DEEPSEEK_CONVERSATION_ID);
        expect(parsed.searchParams.has('cache_version')).toBeFalse();
        expect(parsed.searchParams.has('cache_reset_at')).toBeFalse();
        expect(deepSeekAdapter.buildApiUrls?.(SYNTHETIC_DEEPSEEK_CONVERSATION_ID)).toEqual([url]);
        expect(deepSeekAdapter.buildApiUrls?.('not-a-uuid')).toEqual([]);
    });

    it('should narrowly classify only canonical history detail GETs for response caching', () => {
        expect(deepSeekAdapter.isConversationDetailRequest?.(SYNTHETIC_DEEPSEEK_HISTORY_URL, 'GET')).toBeTrue();
        expect(deepSeekAdapter.isConversationDetailRequest?.(SYNTHETIC_DEEPSEEK_HISTORY_URL, 'get')).toBeTrue();
        expect(deepSeekAdapter.isConversationDetailRequest?.(SYNTHETIC_DEEPSEEK_HISTORY_URL, 'POST')).toBeFalse();
        expect(
            deepSeekAdapter.isConversationDetailRequest?.(
                `https://chat.deepseek.com/api/v0/chat/history_messages?cache_version=7`,
                'GET',
            ),
        ).toBeFalse();
        expect(
            deepSeekAdapter.isConversationDetailRequest?.(
                `https://example.com/api/v0/chat/history_messages?chat_session_id=${SYNTHETIC_DEEPSEEK_CONVERSATION_ID}`,
                'GET',
            ),
        ).toBeFalse();
        expect(
            deepSeekAdapter.isConversationDetailRequest?.(
                `https://chat.deepseek.com/api/v0/chat/completion?chat_session_id=${SYNTHETIC_DEEPSEEK_CONVERSATION_ID}`,
                'GET',
            ),
        ).toBeFalse();
    });

    it('should recognize only successful non-empty history payload shapes', () => {
        const payload = createSyntheticDeepSeekHistoryResponse();

        expect(deepSeekAdapter.isConversationPayload?.(payload)).toBeTrue();
        payload.data.biz_data.chat_session.is_empty = true;
        expect(deepSeekAdapter.isConversationPayload?.(payload)).toBeFalse();
    });

    it('should parse and preserve the sanitized canonical history response', () => {
        const payload = createSyntheticDeepSeekHistoryResponse();
        const parsed = deepSeekAdapter.parseInterceptedData(JSON.stringify(payload), SYNTHETIC_DEEPSEEK_HISTORY_URL);

        expect(parsed).not.toBeNull();
        expect(parsed?.conversation_id).toBe(SYNTHETIC_DEEPSEEK_CONVERSATION_ID);
        expect(parsed?.title).toBe('Synthetic DeepSeek Conversation');
        expect(parsed?.current_node).toBe('202');
        expect(parsed?.mapping['101']?.parent).toContain('deepseek-root-');
        expect(parsed?.mapping['202']?.parent).toBe('101');
        expect(parsed?.mapping['202']?.message?.content.parts).toEqual(['Synthetic terminal answer.']);
        expect(parsed?.mapping['202']?.message?.content.thoughts).toEqual([
            {
                summary: 'Reasoning',
                content: 'Synthetic reasoning summary.',
                chunks: [],
                finished: true,
            },
        ]);
        expect(parsed?.raw_payload).toEqual(JSON.parse(JSON.stringify(payload)));
        expect(parsed?.raw_payload).not.toBe(payload);
    });

    it('should parse the current null-root history response with reasoning and answer text', () => {
        const payload = createCurrentDeepSeekHistoryResponse();
        const parsed = deepSeekAdapter.parseInterceptedData(
            JSON.stringify(payload),
            SYNTHETIC_DEEPSEEK_FULL_HISTORY_URL,
        );

        expect(parsed?.mapping['101']?.parent).toContain('deepseek-root-');
        expect(parsed?.mapping['202']?.message?.content.thoughts?.[0]?.content).toContain(
            'The user is asking about the total',
        );
        expect(parsed?.mapping['202']?.message?.content.parts).toEqual([
            'There is no single, universally agreed answer.',
        ]);
        expect(deepSeekAdapter.evaluateReadiness?.(parsed!)).toMatchObject({ ready: true, terminal: true });
    });

    it('should format a sanitized bounded filename', () => {
        const payload = createSyntheticDeepSeekHistoryResponse();
        payload.data.biz_data.chat_session.title = 'Synthetic / DeepSeek: Conversation?';
        const parsed = deepSeekAdapter.parseInterceptedData(JSON.stringify(payload), SYNTHETIC_DEEPSEEK_HISTORY_URL);

        expect(parsed).not.toBeNull();
        const filename = deepSeekAdapter.formatFilename(parsed!);
        expect(filename).toStartWith('Synthetic_DeepSeek_Conversation_');
        expect(filename).not.toMatch(/[/\\:*?"<>|]/);
    });
});
