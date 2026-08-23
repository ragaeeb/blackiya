import { describe, expect, it } from 'bun:test';
import {
    createSyntheticDeepSeekHistoryResponse,
    SYNTHETIC_DEEPSEEK_CONVERSATION_ID,
    SYNTHETIC_DEEPSEEK_HISTORY_URL,
} from './fixtures/history-response';
import { parseDeepSeekHistoryResponse } from './parser';

describe('DeepSeek history parser', () => {
    it('should preserve every canonical provider branch in raw_payload', () => {
        const payload = createSyntheticDeepSeekHistoryResponse();
        payload.data.biz_data.chat_messages.push({
            ...structuredClone(payload.data.biz_data.chat_messages[1]!),
            message_id: 303,
            parent_id: 101,
            inserted_at: 1_700_000_009,
            fragments: [
                { id: 4, type: 'RESPONSE', content: 'Synthetic alternate answer.', stage_id: 2, references: [] },
            ],
            canonical_message_field: { retained: 'alternate-assistant' },
        });

        const parsed = parseDeepSeekHistoryResponse(JSON.stringify(payload), SYNTHETIC_DEEPSEEK_HISTORY_URL);

        expect(parsed?.mapping['101']?.children).toEqual(['202', '303']);
        expect(parsed?.mapping['303']?.message?.content.parts).toEqual(['Synthetic alternate answer.']);
        expect(parsed?.raw_payload).toEqual(JSON.parse(JSON.stringify(payload)));
        expect(JSON.parse(JSON.stringify(parsed?.raw_payload))).toEqual(payload);
    });

    it('should reject malformed, unsuccessful, empty, and mismatched payloads', () => {
        expect(parseDeepSeekHistoryResponse('{"broken"', SYNTHETIC_DEEPSEEK_HISTORY_URL)).toBeNull();

        const unsuccessful = createSyntheticDeepSeekHistoryResponse();
        unsuccessful.data.biz_code = 1;
        expect(parseDeepSeekHistoryResponse(JSON.stringify(unsuccessful), SYNTHETIC_DEEPSEEK_HISTORY_URL)).toBeNull();

        const empty = createSyntheticDeepSeekHistoryResponse();
        empty.data.biz_data.chat_session.is_empty = true;
        empty.data.biz_data.chat_messages = [];
        expect(parseDeepSeekHistoryResponse(JSON.stringify(empty), SYNTHETIC_DEEPSEEK_HISTORY_URL)).toBeNull();

        const mismatch = createSyntheticDeepSeekHistoryResponse();
        mismatch.data.biz_data.chat_session.id = '22222222-2222-4222-8222-222222222222';
        expect(parseDeepSeekHistoryResponse(JSON.stringify(mismatch), SYNTHETIC_DEEPSEEK_HISTORY_URL)).toBeNull();
    });

    it('should reject non-DeepSeek and non-history endpoint URLs', () => {
        const payload = JSON.stringify(createSyntheticDeepSeekHistoryResponse());

        expect(
            parseDeepSeekHistoryResponse(
                payload,
                `https://example.com/api/v0/chat/history_messages?chat_session_id=${SYNTHETIC_DEEPSEEK_CONVERSATION_ID}`,
            ),
        ).toBeNull();
        expect(
            parseDeepSeekHistoryResponse(
                payload,
                `https://chat.deepseek.com/api/v0/chat/completion?chat_session_id=${SYNTHETIC_DEEPSEEK_CONVERSATION_ID}`,
            ),
        ).toBeNull();
    });

    it('should keep non-terminal provider state parseable for fail-closed readiness evaluation', () => {
        const payload = createSyntheticDeepSeekHistoryResponse();
        const assistant = payload.data.biz_data.chat_messages[1]!;
        assistant.status = 'PENDING';
        assistant.has_pending_fragment = true;

        const parsed = parseDeepSeekHistoryResponse(JSON.stringify(payload), SYNTHETIC_DEEPSEEK_HISTORY_URL);

        expect(parsed?.mapping['202']?.message?.status).toBe('in_progress');
        expect(parsed?.mapping['202']?.message?.end_turn).toBeFalse();
        expect(parsed?.raw_payload).toEqual(JSON.parse(JSON.stringify(payload)));
    });
});
