import { describe, expect, it } from 'bun:test';
import {
    createQwenConversationDetailFixture,
    QWEN_FIXTURE_ASSISTANT_MESSAGE_ID,
    QWEN_FIXTURE_CONVERSATION_ID,
    QWEN_FIXTURE_USER_MESSAGE_ID,
} from './fixtures/conversation-detail';
import { createQwenConversationListFixture } from './fixtures/conversation-list';
import { parseQwenConversationDetail, parseQwenConversationList } from './parser';

const DETAIL_URL = `https://chat.qwen.ai/api/v2/chats/${QWEN_FIXTURE_CONVERSATION_ID}?direction=up&limit=10`;

describe('parseQwenConversationDetail', () => {
    it('should normalize the sanitized HAR-derived terminal detail payload and preserve the full envelope', () => {
        const payload = createQwenConversationDetailFixture();
        const result = parseQwenConversationDetail(JSON.stringify(payload), DETAIL_URL);

        expect(result).not.toBeNull();
        expect(result?.conversation_id).toBe(QWEN_FIXTURE_CONVERSATION_ID);
        expect(result?.title).toBe('Synthetic Qwen Conversation');
        expect(result?.create_time).toBe(1_700_000_000);
        expect(result?.update_time).toBe(1_700_000_002);
        expect(result?.current_node).toBe(QWEN_FIXTURE_ASSISTANT_MESSAGE_ID);
        expect(result?.mapping[QWEN_FIXTURE_USER_MESSAGE_ID]?.children).toEqual([QWEN_FIXTURE_ASSISTANT_MESSAGE_ID]);
        expect(result?.mapping[QWEN_FIXTURE_ASSISTANT_MESSAGE_ID]?.parent).toBe(QWEN_FIXTURE_USER_MESSAGE_ID);
        expect(result?.mapping[QWEN_FIXTURE_ASSISTANT_MESSAGE_ID]?.message?.content.parts).toEqual([
            'Synthetic terminal answer.',
        ]);
        expect(result?.mapping[QWEN_FIXTURE_ASSISTANT_MESSAGE_ID]?.message?.status).toBe('finished_successfully');
        expect(result?.raw_payload).toEqual(payload);
    });

    it('should accept the ID-keyed history map when the duplicate ordered message array is absent', () => {
        const payload = createQwenConversationDetailFixture();
        payload.data.chat.messages = [];

        const result = parseQwenConversationDetail(payload, DETAIL_URL);

        expect(Object.keys(result?.mapping ?? {})).toEqual([
            QWEN_FIXTURE_USER_MESSAGE_ID,
            QWEN_FIXTURE_ASSISTANT_MESSAGE_ID,
        ]);
    });

    it('should reject malformed, unsuccessful, wrong-endpoint, and ID-mismatched payloads', () => {
        const unsuccessful = createQwenConversationDetailFixture();
        unsuccessful.success = false;
        const mismatched = createQwenConversationDetailFixture();
        mismatched.data.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

        expect(parseQwenConversationDetail('{"broken"', DETAIL_URL)).toBeNull();
        expect(parseQwenConversationDetail(unsuccessful, DETAIL_URL)).toBeNull();
        expect(
            parseQwenConversationDetail(createQwenConversationDetailFixture(), 'https://chat.qwen.ai/api/v2/chats/'),
        ).toBeNull();
        expect(parseQwenConversationDetail(mismatched, DETAIL_URL)).toBeNull();
    });
});

describe('parseQwenConversationList', () => {
    it('should parse sanitized list summaries without retaining unrelated fields', () => {
        const result = parseQwenConversationList(JSON.stringify(createQwenConversationListFixture()));

        expect(result).toEqual([
            {
                id: QWEN_FIXTURE_CONVERSATION_ID,
                title: 'Synthetic Qwen Conversation',
                createdAt: 1_700_000_000,
                updatedAt: 1_700_000_002,
            },
        ]);
    });

    it('should fail closed for malformed or unsuccessful list payloads', () => {
        const unsuccessful = createQwenConversationListFixture();
        unsuccessful.success = false;

        expect(parseQwenConversationList('{"broken"')).toBeNull();
        expect(parseQwenConversationList(unsuccessful)).toBeNull();
        expect(parseQwenConversationList({ success: true, data: {} })).toBeNull();
    });
});
