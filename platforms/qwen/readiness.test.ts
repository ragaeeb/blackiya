import { describe, expect, it } from 'bun:test';
import {
    createQwenConversationDetailFixture,
    QWEN_FIXTURE_ASSISTANT_MESSAGE_ID,
    QWEN_FIXTURE_CONVERSATION_ID,
    QWEN_FIXTURE_USER_MESSAGE_ID,
} from './fixtures/conversation-detail';
import { parseQwenConversationDetail } from './parser';
import { evaluateQwenReadiness } from './readiness';

const DETAIL_URL = `https://chat.qwen.ai/api/v2/chats/${QWEN_FIXTURE_CONVERSATION_ID}?direction=up&limit=10`;

type MutableAssistantFixture = {
    done: boolean;
    is_stop: boolean;
    error: unknown;
    content_list: Array<{ content: string; status: string }>;
};

const getAssistantFixtures = (payload: ReturnType<typeof createQwenConversationDetailFixture>) => [
    payload.data.chat.messages[1] as unknown as MutableAssistantFixture,
    payload.data.chat.history.messages[QWEN_FIXTURE_ASSISTANT_MESSAGE_ID] as unknown as MutableAssistantFixture,
];

const parseFixture = (mutate?: (payload: ReturnType<typeof createQwenConversationDetailFixture>) => void) => {
    const payload = createQwenConversationDetailFixture();
    mutate?.(payload);
    const parsed = parseQwenConversationDetail(payload, DETAIL_URL);
    if (!parsed) {
        throw new Error('Synthetic Qwen fixture failed to parse');
    }
    return parsed;
};

describe('evaluateQwenReadiness', () => {
    it('should accept a complete active assistant with a finished answer segment', () => {
        const result = evaluateQwenReadiness(parseFixture());

        expect(result.ready).toBeTrue();
        expect(result.terminal).toBeTrue();
        expect(result.reason).toBe('terminal');
        expect(result.contentHash).not.toBeNull();
        expect(result.latestAssistantTextLength).toBe('Synthetic terminal answer.'.length);
    });

    it('should reject paginated snapshots that omit older or newer messages', () => {
        const older = evaluateQwenReadiness(
            parseFixture((payload) => {
                payload.data.chat.history.pagination.has_more_older = true;
            }),
        );
        const newer = evaluateQwenReadiness(
            parseFixture((payload) => {
                payload.data.chat.history.pagination.has_more_newer = true;
            }),
        );

        expect(older).toMatchObject({ ready: false, terminal: false, reason: 'history-incomplete' });
        expect(newer).toMatchObject({ ready: false, terminal: false, reason: 'history-incomplete' });
    });

    it('should reject active assistant data that is unfinished, stopped, errored, or missing a finished answer', () => {
        const unfinished = evaluateQwenReadiness(
            parseFixture((payload) => {
                for (const assistant of getAssistantFixtures(payload)) {
                    assistant.done = false;
                }
            }),
        );
        const stopped = evaluateQwenReadiness(
            parseFixture((payload) => {
                for (const assistant of getAssistantFixtures(payload)) {
                    assistant.is_stop = true;
                }
            }),
        );
        const errored = evaluateQwenReadiness(
            parseFixture((payload) => {
                for (const assistant of getAssistantFixtures(payload)) {
                    assistant.error = { code: 'fixture_error' };
                }
            }),
        );
        const missingAnswer = evaluateQwenReadiness(
            parseFixture((payload) => {
                for (const assistant of getAssistantFixtures(payload)) {
                    assistant.content_list[1]!.content = '';
                }
            }),
        );
        const streamingAnswer = evaluateQwenReadiness(
            parseFixture((payload) => {
                for (const assistant of getAssistantFixtures(payload)) {
                    assistant.content_list[1]!.status = 'streaming';
                }
            }),
        );

        expect(unfinished.reason).toBe('assistant-in-progress');
        expect(stopped.reason).toBe('assistant-stopped');
        expect(errored.reason).toBe('assistant-error');
        expect(missingAnswer.reason).toBe('assistant-answer-missing');
        expect(streamingAnswer.reason).toBe('assistant-in-progress');
        for (const result of [unfinished, stopped, errored, missingAnswer, streamingAnswer]) {
            expect(result.ready).toBeFalse();
            expect(result.terminal).toBeFalse();
        }
    });

    it('should reject a current node that is not an assistant message', () => {
        const data = parseFixture();
        data.current_node = QWEN_FIXTURE_USER_MESSAGE_ID;
        const result = evaluateQwenReadiness(data);

        expect(result).toMatchObject({ ready: false, terminal: false, reason: 'assistant-missing' });
    });
});
