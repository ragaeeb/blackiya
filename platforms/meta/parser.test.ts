import { describe, expect, it } from 'bun:test';
import {
    createMetaDetailFixture,
    createMetaOlderPageFixture,
    SYNTHETIC_META_CONVERSATION_ID,
} from './fixtures/conversation';
import { isMetaConversationPayload, parseMetaConversationArchive, parseMetaConversationPayload } from './parser';

describe('Meta Muse conversation parser', () => {
    it('should normalize a complete conversation while preserving the canonical response', () => {
        const payload = createMetaDetailFixture();
        const parsed = parseMetaConversationPayload(payload);

        expect(parsed?.conversation_id).toBe(SYNTHETIC_META_CONVERSATION_ID);
        expect(parsed?.title).toBe('Synthetic Meta Muse Conversation');
        expect(parsed?.current_node).toBe('synthetic-assistant-message');
        expect(parsed?.mapping['synthetic-user-message']?.message?.author.role).toBe('user');
        expect(parsed?.mapping['synthetic-assistant-message']?.message?.author.role).toBe('assistant');
        expect(parsed?.mapping['synthetic-assistant-message']?.message?.status).toBe('finished_successfully');
        expect(parsed?.raw_payload as unknown).toEqual(payload);
    });

    it('should prepend backward pages and preserve every original response', () => {
        const initial = createMetaDetailFixture({ hasPreviousPage: true });
        const olderPage = createMetaOlderPageFixture();
        const parsed = parseMetaConversationArchive(initial, [olderPage]);

        expect(Object.keys(parsed?.mapping ?? {})).toEqual([
            'synthetic-older-assistant-message',
            'synthetic-user-message',
            'synthetic-assistant-message',
        ]);
        expect(parsed?.mapping['synthetic-older-assistant-message']?.children).toEqual(['synthetic-user-message']);
        expect(parsed?.raw_payload as unknown).toEqual({
            initial_response: initial,
            pagination_responses: [olderPage],
        });
        expect(initial.data.conversation.messages.edges).toHaveLength(2);
    });

    it('should reject pagination from another conversation', () => {
        const initial = createMetaDetailFixture({ hasPreviousPage: true });
        const mismatchedPage = createMetaOlderPageFixture('22222222-2222-4222-8222-222222222222');

        expect(parseMetaConversationArchive(initial, [mismatchedPage])).toBeNull();
    });

    it('should reject unknown message roles and unrelated payloads', () => {
        const unknownRole = createMetaDetailFixture();
        unknownRole.data.conversation.messages.edges[0]!.node.__typename = 'SyntheticUnknownMessage';
        unknownRole.data.conversation.messages.edges[0]!.node.__isMessage = 'SyntheticUnknownMessage';

        expect(parseMetaConversationPayload(unknownRole)).toBeNull();
        expect(parseMetaConversationPayload({ data: { viewer: {} } })).toBeNull();
        expect(isMetaConversationPayload({ data: { viewer: {} } })).toBeFalse();
    });

    it('should parse a JSON string only when it has the conversation detail shape', () => {
        const payload = createMetaDetailFixture();

        expect(parseMetaConversationPayload(JSON.stringify(payload))?.conversation_id).toBe(
            SYNTHETIC_META_CONVERSATION_ID,
        );
        expect(parseMetaConversationPayload('{')).toBeNull();
        expect(isMetaConversationPayload(payload)).toBeTrue();
    });
});
