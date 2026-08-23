import { describe, expect, it } from 'bun:test';
import type { RawConversationPayload } from '@/utils/types';
import {
    CLAUDE_DETAIL_URL,
    createClaudeTerminalPayload,
    SYNTHETIC_ASSISTANT_MESSAGE_ID,
    SYNTHETIC_CONVERSATION_ID,
    SYNTHETIC_USER_MESSAGE_ID,
} from './fixtures/conversation';
import { claudeAdapter } from './index';

describe('Claude adapter', () => {
    describe('URL matching', () => {
        it('should support claude.ai conversation URLs', () => {
            const pageUrl = `https://claude.ai/chat/${SYNTHETIC_CONVERSATION_ID}`;

            expect(claudeAdapter.isPlatformUrl(pageUrl)).toBeTrue();
            expect(claudeAdapter.extractConversationId(pageUrl)).toBe(SYNTHETIC_CONVERSATION_ID);
            expect(claudeAdapter.extractConversationId(`${pageUrl}?from=history`)).toBe(SYNTHETIC_CONVERSATION_ID);
        });

        it('should reject non-Claude hosts and non-conversation paths', () => {
            expect(
                claudeAdapter.isPlatformUrl(`https://claude.ai.example/chat/${SYNTHETIC_CONVERSATION_ID}`),
            ).toBeFalse();
            expect(claudeAdapter.isPlatformUrl(`http://claude.ai/chat/${SYNTHETIC_CONVERSATION_ID}`)).toBeFalse();
            expect(claudeAdapter.extractConversationId('https://claude.ai/new')).toBeNull();
            expect(claudeAdapter.extractConversationId('not a URL')).toBeNull();
        });
    });

    describe('canonical detail parsing', () => {
        it('should preserve the full provider payload and structured message blocks', () => {
            const payload = createClaudeTerminalPayload();

            const result = claudeAdapter.parseInterceptedData(JSON.stringify(payload), CLAUDE_DETAIL_URL);

            expect(result).not.toBeNull();
            expect(result?.conversation_id).toBe(SYNTHETIC_CONVERSATION_ID);
            expect(result?.current_node).toBe(SYNTHETIC_ASSISTANT_MESSAGE_ID);
            expect(result?.raw_payload).toEqual(payload as unknown as RawConversationPayload);
            expect(result?.mapping[SYNTHETIC_USER_MESSAGE_ID]?.parent).toBeNull();
            expect(result?.mapping[SYNTHETIC_USER_MESSAGE_ID]?.children).toEqual([SYNTHETIC_ASSISTANT_MESSAGE_ID]);
            expect(result?.mapping[SYNTHETIC_ASSISTANT_MESSAGE_ID]?.message?.content.parts).toEqual(
                payload.chat_messages[1]?.content,
            );
            expect(result?.mapping[SYNTHETIC_ASSISTANT_MESSAGE_ID]?.message?.content.content).toBe(
                'Synthetic final answer.',
            );
            expect(result?.mapping[SYNTHETIC_ASSISTANT_MESSAGE_ID]?.message?.status).toBe('finished_successfully');
            expect(result?.mapping[SYNTHETIC_ASSISTANT_MESSAGE_ID]?.message?.end_turn).toBeTrue();
        });

        it('should reject malformed, mismatched, and incomplete canonical payloads', () => {
            const mismatched = createClaudeTerminalPayload();
            mismatched.uuid = '60000000-0000-4000-8000-000000000006';
            const missingLeaf = createClaudeTerminalPayload();
            missingLeaf.current_leaf_message_uuid = '70000000-0000-4000-8000-000000000007';

            expect(claudeAdapter.parseInterceptedData('{', CLAUDE_DETAIL_URL)).toBeNull();
            expect(claudeAdapter.parseInterceptedData(JSON.stringify(mismatched), CLAUDE_DETAIL_URL)).toBeNull();
            expect(claudeAdapter.parseInterceptedData(JSON.stringify(missingLeaf), CLAUDE_DETAIL_URL)).toBeNull();
            expect(
                claudeAdapter.parseInterceptedData(
                    JSON.stringify(createClaudeTerminalPayload()),
                    CLAUDE_DETAIL_URL.replace('claude.ai', 'example.com'),
                ),
            ).toBeNull();
        });

        it('should identify only canonical Claude conversation payloads', () => {
            expect(claudeAdapter.isConversationPayload?.(createClaudeTerminalPayload())).toBeTrue();
            expect(claudeAdapter.isConversationPayload?.({ uuid: SYNTHETIC_CONVERSATION_ID })).toBeFalse();
        });
    });

    it('should format a sanitized bounded filename', () => {
        const payload = createClaudeTerminalPayload();
        payload.name = `Synthetic: Claude/Conversation? ${'x'.repeat(120)}`;
        const parsed = claudeAdapter.parseInterceptedData(JSON.stringify(payload), CLAUDE_DETAIL_URL);

        expect(parsed).not.toBeNull();
        const filename = claudeAdapter.formatFilename(parsed!);
        expect(filename).not.toMatch(/[:/\\?<>"|*]/);
        expect(filename.length).toBeLessThan(120);
        expect(filename).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('should expose the narrow canonical detail-request cache matcher', () => {
        expect(claudeAdapter.isConversationDetailRequest?.(CLAUDE_DETAIL_URL, 'GET')).toBeTrue();
        expect(claudeAdapter.isConversationDetailRequest?.(CLAUDE_DETAIL_URL, 'POST')).toBeFalse();
    });
});
