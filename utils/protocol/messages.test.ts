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
        ).toBeTrue();
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_STREAM_DUMP_CONFIG',
                enabled: true,
            }),
        ).toBeTrue();
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_STREAM_DUMP_FRAME',
                platform: 'ChatGPT',
                attemptId: 'a-1',
                kind: 'snapshot',
                text: 'hello',
            }),
        ).toBeTrue();
    });

    it('rejects lifecycle and completion messages without attempt IDs', () => {
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
                conversationId: 'conv-1',
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

    it('does not expose removed legacy helper exports', () => {
        expect('isLegacyLifecycleMessage' in protocol).toBeFalse();
        expect('isLegacyFinishedMessage' in protocol).toBeFalse();
        expect('isLegacyStreamDeltaMessage' in protocol).toBeFalse();
        expect('buildLegacyAttemptId' in protocol).toBeFalse();
    });

    it('creates attempt IDs', () => {
        const attemptId = protocol.createAttemptId('test');
        expect(attemptId.startsWith('test:')).toBeTrue();
    });
});
