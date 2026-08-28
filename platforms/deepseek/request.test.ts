import { describe, expect, it } from 'bun:test';
import { SYNTHETIC_DEEPSEEK_CONVERSATION_ID, SYNTHETIC_DEEPSEEK_HISTORY_URL } from './fixtures/history-response';
import { buildDeepSeekHistoryRequest, parseDeepSeekHistoryRequestContext } from './request';

const syntheticClientHeaders = {
    authorization: 'Bearer synthetic-deepseek-token',
    'x-client-bundle-id': 'synthetic-bundle',
    'x-client-locale': 'en-CA',
    'x-client-platform': 'web',
    'x-client-timezone-offset': '-240',
    'x-client-version': 'synthetic-version',
};

describe('DeepSeek history request helpers', () => {
    it('should parse only the observed non-secret request context', () => {
        const context = parseDeepSeekHistoryRequestContext(SYNTHETIC_DEEPSEEK_HISTORY_URL, {
            ...syntheticClientHeaders,
            'x-unrelated-header': 'ignored',
        });

        expect(context).toEqual({
            conversationId: SYNTHETIC_DEEPSEEK_CONVERSATION_ID,
            cacheVersion: '7',
            cacheResetAt: '1700000000',
            headers: syntheticClientHeaders,
        });
    });

    it('should build an exact GET request with ambient credentials and optional cache context', () => {
        const context = parseDeepSeekHistoryRequestContext(SYNTHETIC_DEEPSEEK_HISTORY_URL, syntheticClientHeaders);
        (context!.headers as Record<string, string>)['x-unrelated-header'] = 'ignored';
        const request = buildDeepSeekHistoryRequest(SYNTHETIC_DEEPSEEK_CONVERSATION_ID, context!);

        expect(request).not.toBeNull();
        expect(request?.method).toBe('GET');
        expect(request?.credentials).toBe('include');
        expect(request?.headers).toEqual(syntheticClientHeaders);
        const url = new URL(request!.url);
        expect(url.pathname).toBe('/api/v0/chat/history_messages');
        expect(url.searchParams.get('chat_session_id')).toBe(SYNTHETIC_DEEPSEEK_CONVERSATION_ID);
        expect(url.searchParams.get('cache_version')).toBe('7');
        expect(url.searchParams.get('cache_reset_at')).toBe('1700000000');
    });

    it('should reject malformed IDs, foreign hosts, and unrelated endpoints', () => {
        expect(buildDeepSeekHistoryRequest('not-a-uuid')).toBeNull();
        expect(
            parseDeepSeekHistoryRequestContext(
                `https://example.com/api/v0/chat/history_messages?chat_session_id=${SYNTHETIC_DEEPSEEK_CONVERSATION_ID}`,
                syntheticClientHeaders,
            ),
        ).toBeNull();
        expect(
            parseDeepSeekHistoryRequestContext(
                `https://chat.deepseek.com/api/v0/chat/completion?chat_session_id=${SYNTHETIC_DEEPSEEK_CONVERSATION_ID}`,
                syntheticClientHeaders,
            ),
        ).toBeNull();
    });

    it('should reject noncanonical history query variants', () => {
        const base =
            `https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=` +
            SYNTHETIC_DEEPSEEK_CONVERSATION_ID;
        const variants = [
            `${base}&extra=true`,
            `${base}&cursor=synthetic`,
            `${base}&chat_session_id=${SYNTHETIC_DEEPSEEK_CONVERSATION_ID}`,
            `${base}&cache_version=7&cache_version=8`,
            `${base}&cache_reset_at=`,
            `${base}#fragment`,
            base.replace('https://', 'https://synthetic-user@'),
        ];

        for (const url of variants) {
            expect(parseDeepSeekHistoryRequestContext(url, syntheticClientHeaders)).toBeNull();
        }
    });
});
