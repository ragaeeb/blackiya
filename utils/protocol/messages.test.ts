import { describe, expect, it } from 'bun:test';
import * as protocol from '@/utils/protocol/messages';

describe('protocol/messages', () => {
    it('validates typed lifecycle messages', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'a-1',
                phase: 'prompt-sent',
            }),
        ).toBe(true);
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_STREAM_DUMP_CONFIG',
                enabled: true,
            }),
        ).toBe(true);
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_STREAM_DUMP_FRAME',
                platform: 'ChatGPT',
                attemptId: 'a-1',
                kind: 'snapshot',
                text: 'hello',
            }),
        ).toBe(true);
    });

    it('rejects lifecycle and completion messages without attempt IDs', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                phase: 'streaming',
            }),
        ).toBe(false);
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'ChatGPT',
                conversationId: 'conv-1',
            }),
        ).toBe(false);
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                text: 'hello',
            }),
        ).toBe(false);
    });

    it('does not expose removed legacy helper exports', () => {
        expect('isLegacyLifecycleMessage' in protocol).toBe(false);
        expect('isLegacyFinishedMessage' in protocol).toBe(false);
        expect('isLegacyStreamDeltaMessage' in protocol).toBe(false);
        expect('buildLegacyAttemptId' in protocol).toBe(false);
    });

    it('creates attempt IDs', () => {
        const attemptId = protocol.createAttemptId('test');
        expect(attemptId.startsWith('test:')).toBe(true);
    });
});
