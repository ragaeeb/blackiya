import { describe, expect, it } from 'bun:test';
import * as protocol from '@/utils/protocol/messages';

describe('integration: strict protocol message contracts', () => {
    it('requires attemptId for lifecycle and completion events', () => {
        const lifecycle = {
            type: 'BLACKIYA_RESPONSE_LIFECYCLE',
            platform: 'ChatGPT',
            phase: 'streaming',
            conversationId: 'c1',
            attemptId: 'chatgpt:a1',
        };
        const finished = {
            type: 'BLACKIYA_RESPONSE_FINISHED',
            platform: 'ChatGPT',
            conversationId: 'c1',
            attemptId: 'chatgpt:a1',
        };
        const delta = {
            type: 'BLACKIYA_STREAM_DELTA',
            platform: 'ChatGPT',
            conversationId: 'c1',
            text: 'hello',
            attemptId: 'chatgpt:a1',
        };

        expect(protocol.isBlackiyaMessage(lifecycle)).toBeTrue();
        expect(protocol.isBlackiyaMessage(finished)).toBeTrue();
        expect(protocol.isBlackiyaMessage(delta)).toBeTrue();
    });

    it('rejects attempt-less lifecycle and completion events', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                phase: 'streaming',
            }),
        ).toBeFalse();

        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'ChatGPT',
            }),
        ).toBeFalse();

        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                text: 'hello',
            }),
        ).toBeFalse();
    });
});
