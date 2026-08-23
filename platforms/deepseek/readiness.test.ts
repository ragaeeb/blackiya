import { describe, expect, it } from 'bun:test';
import { createSyntheticDeepSeekHistoryResponse, SYNTHETIC_DEEPSEEK_HISTORY_URL } from './fixtures/history-response';
import { parseDeepSeekHistoryResponse } from './parser';
import { evaluateDeepSeekReadiness } from './readiness';

const parseFixture = () =>
    parseDeepSeekHistoryResponse(
        JSON.stringify(createSyntheticDeepSeekHistoryResponse()),
        SYNTHETIC_DEEPSEEK_HISTORY_URL,
    )!;

describe('DeepSeek readiness', () => {
    it('should accept the current finished assistant response as terminal', () => {
        const readiness = evaluateDeepSeekReadiness(parseFixture());

        expect(readiness.ready).toBeTrue();
        expect(readiness.terminal).toBeTrue();
        expect(readiness.reason).toBe('terminal');
        expect(readiness.contentHash).not.toBeNull();
        expect(readiness.latestAssistantTextLength).toBe('Synthetic terminal answer.'.length);
    });

    for (const mutation of [
        { label: 'unfinished status', apply: (message: any) => (message.status = 'PENDING') },
        { label: 'pending fragment', apply: (message: any) => (message.has_pending_fragment = true) },
        {
            label: 'missing pending-fragment marker',
            apply: (message: any) => delete message.has_pending_fragment,
        },
        { label: 'incomplete message', apply: (message: any) => (message.incomplete_message = { synthetic: true }) },
        { label: 'automatic continuation', apply: (message: any) => (message.auto_continue = true) },
        {
            label: 'missing automatic-continuation marker',
            apply: (message: any) => delete message.auto_continue,
        },
    ]) {
        it(`should fail closed for ${mutation.label}`, () => {
            const payload = createSyntheticDeepSeekHistoryResponse();
            mutation.apply(payload.data.biz_data.chat_messages[1]!);
            const parsed = parseDeepSeekHistoryResponse(JSON.stringify(payload), SYNTHETIC_DEEPSEEK_HISTORY_URL);

            expect(parsed).not.toBeNull();
            expect(evaluateDeepSeekReadiness(parsed!)).toMatchObject({
                ready: false,
                terminal: false,
                reason: 'assistant-in-progress',
            });
        });
    }

    it('should fail closed when the current message is not an assistant turn', () => {
        const payload = createSyntheticDeepSeekHistoryResponse();
        payload.data.biz_data.chat_session.current_message_id = 101;
        const parsed = parseDeepSeekHistoryResponse(JSON.stringify(payload), SYNTHETIC_DEEPSEEK_HISTORY_URL);

        expect(parsed).not.toBeNull();
        expect(evaluateDeepSeekReadiness(parsed!)).toMatchObject({
            ready: false,
            terminal: false,
            reason: 'current-assistant-missing',
        });
    });

    it('should fail closed when the terminal assistant response text is empty', () => {
        const payload = createSyntheticDeepSeekHistoryResponse();
        payload.data.biz_data.chat_messages[1]!.fragments[1]!.content = '   ';
        const parsed = parseDeepSeekHistoryResponse(JSON.stringify(payload), SYNTHETIC_DEEPSEEK_HISTORY_URL);

        expect(parsed).not.toBeNull();
        expect(evaluateDeepSeekReadiness(parsed!)).toMatchObject({
            ready: false,
            terminal: true,
            reason: 'assistant-text-missing',
        });
    });
});
