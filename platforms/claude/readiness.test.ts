import { describe, expect, it } from 'bun:test';
import {
    CLAUDE_DETAIL_URL,
    createClaudeTerminalPayload,
    SYNTHETIC_ASSISTANT_MESSAGE_ID,
    SYNTHETIC_USER_MESSAGE_ID,
} from './fixtures/conversation';
import { claudeAdapter } from './index';

const parseFixture = (mutate?: (payload: ReturnType<typeof createClaudeTerminalPayload>) => void) => {
    const payload = createClaudeTerminalPayload();
    mutate?.(payload);
    const parsed = claudeAdapter.parseInterceptedData(JSON.stringify(payload), CLAUDE_DETAIL_URL);
    expect(parsed).not.toBeNull();
    return parsed!;
};

describe('Claude readiness', () => {
    it('should accept a non-truncated current assistant leaf with end_turn', () => {
        const readiness = claudeAdapter.evaluateReadiness?.(parseFixture());

        expect(readiness).toMatchObject({
            ready: true,
            terminal: true,
            reason: 'terminal',
            latestAssistantTextLength: 'Synthetic final answer.'.length,
        });
        expect(readiness?.contentHash).not.toBeNull();
    });

    it('should fail closed while the current assistant leaf has no stop reason', () => {
        const readiness = claudeAdapter.evaluateReadiness?.(
            parseFixture((payload) => {
                payload.chat_messages[1]!.stop_reason = null;
            }),
        );

        expect(readiness).toMatchObject({
            ready: false,
            terminal: false,
            reason: 'assistant-in-progress',
        });
    });

    it('should fail closed for truncated terminal data', () => {
        const readiness = claudeAdapter.evaluateReadiness?.(
            parseFixture((payload) => {
                payload.chat_messages[1]!.truncated = true;
            }),
        );

        expect(readiness).toMatchObject({
            ready: false,
            terminal: true,
            reason: 'assistant-truncated',
        });
    });

    it('should fail closed for an intermediate tool-use stop reason', () => {
        const readiness = claudeAdapter.evaluateReadiness?.(
            parseFixture((payload) => {
                payload.chat_messages[1]!.stop_reason = 'tool_use';
            }),
        );

        expect(readiness).toMatchObject({
            ready: false,
            terminal: false,
            reason: 'assistant-non-terminal-stop-reason',
        });
    });

    it('should require the current leaf to be an assistant message', () => {
        const readiness = claudeAdapter.evaluateReadiness?.(
            parseFixture((payload) => {
                payload.current_leaf_message_uuid = SYNTHETIC_USER_MESSAGE_ID;
            }),
        );

        expect(readiness).toMatchObject({
            ready: false,
            terminal: false,
            reason: 'current-assistant-missing',
        });
    });

    it('should accept an explicit terminal structured artifact without text', () => {
        const readiness = claudeAdapter.evaluateReadiness?.(
            parseFixture((payload) => {
                payload.chat_messages[1]!.content = [
                    {
                        type: 'tool_result',
                        tool_use_id: 'synthetic-tool-use-2',
                        name: 'synthetic_tool',
                        content: [{ type: 'text', text: 'Synthetic structured result.' }],
                        is_error: false,
                    },
                ];
            }),
        );

        expect(readiness).toMatchObject({
            ready: true,
            terminal: true,
            reason: 'terminal-structured-content',
            latestAssistantTextLength: 0,
        });
        expect(readiness?.contentHash).not.toBeNull();
    });

    it('should reject an explicit terminal marker with no content', () => {
        const readiness = claudeAdapter.evaluateReadiness?.(
            parseFixture((payload) => {
                payload.chat_messages[1]!.content = [];
            }),
        );

        expect(readiness).toMatchObject({
            ready: false,
            terminal: true,
            reason: 'assistant-content-missing',
        });
    });

    it('should evaluate only the declared current leaf', () => {
        const data = parseFixture();
        data.current_node = SYNTHETIC_ASSISTANT_MESSAGE_ID;
        data.mapping[SYNTHETIC_ASSISTANT_MESSAGE_ID]!.message!.metadata.claude_stop_reason = null;

        expect(claudeAdapter.evaluateReadiness?.(data)).toMatchObject({
            ready: false,
            terminal: false,
            reason: 'assistant-in-progress',
        });
    });
});
