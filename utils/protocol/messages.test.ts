import { describe, expect, it } from 'bun:test';
import {
    buildLegacyAttemptId,
    createAttemptId,
    isBlackiyaMessage,
    isLegacyFinishedMessage,
    isLegacyLifecycleMessage,
    isLegacyStreamDeltaMessage,
} from '@/utils/protocol/messages';

describe('protocol/messages', () => {
    it('validates typed lifecycle messages', () => {
        expect(
            isBlackiyaMessage({
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'a-1',
                phase: 'prompt-sent',
            }),
        ).toBe(true);
        expect(
            isBlackiyaMessage({
                type: 'BLACKIYA_STREAM_DUMP_CONFIG',
                enabled: true,
            }),
        ).toBe(true);
        expect(
            isBlackiyaMessage({
                type: 'BLACKIYA_STREAM_DUMP_FRAME',
                platform: 'ChatGPT',
                attemptId: 'a-1',
                kind: 'snapshot',
                text: 'hello',
            }),
        ).toBe(true);
    });

    it('recognizes legacy lifecycle messages', () => {
        expect(
            isLegacyLifecycleMessage({
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                phase: 'streaming',
            }),
        ).toBe(true);
        expect(
            isLegacyLifecycleMessage({
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                phase: 'streaming',
                attemptId: 'x',
            }),
        ).toBe(false);
    });

    it('recognizes legacy finished and stream delta messages', () => {
        expect(
            isLegacyFinishedMessage({
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'ChatGPT',
            }),
        ).toBe(true);
        expect(
            isLegacyStreamDeltaMessage({
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                text: 'hello',
            }),
        ).toBe(true);
    });

    it('creates attempt IDs and legacy fallback IDs', () => {
        const attemptId = createAttemptId('test');
        expect(attemptId.startsWith('test:')).toBe(true);
        expect(buildLegacyAttemptId('ChatGPT', 'conv-1')).toBe('legacy:ChatGPT:conv-1');
    });
});
