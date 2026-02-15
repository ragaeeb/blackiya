import { describe, expect, it } from 'bun:test';
import {
    buildLegacyAttemptId,
    isLegacyFinishedMessage,
    isLegacyLifecycleMessage,
    isLegacyStreamDeltaMessage,
} from '@/utils/protocol/messages';

describe('integration: legacy message compatibility', () => {
    it('accepts legacy lifecycle/finished/delta messages and maps deterministic legacy attempt IDs', () => {
        const lifecycle = {
            type: 'BLACKIYA_RESPONSE_LIFECYCLE',
            platform: 'ChatGPT',
            phase: 'streaming',
            conversationId: 'c1',
        };
        const finished = {
            type: 'BLACKIYA_RESPONSE_FINISHED',
            platform: 'ChatGPT',
            conversationId: 'c1',
        };
        const delta = {
            type: 'BLACKIYA_STREAM_DELTA',
            platform: 'ChatGPT',
            conversationId: 'c1',
            text: 'hello',
        };

        expect(isLegacyLifecycleMessage(lifecycle)).toBe(true);
        expect(isLegacyFinishedMessage(finished)).toBe(true);
        expect(isLegacyStreamDeltaMessage(delta)).toBe(true);
        expect(buildLegacyAttemptId('ChatGPT', 'c1')).toBe('legacy:ChatGPT:c1');
    });
});
