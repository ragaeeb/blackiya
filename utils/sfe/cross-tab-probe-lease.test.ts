import { describe, expect, it } from 'bun:test';
import { CrossTabProbeLease } from '@/utils/sfe/cross-tab-probe-lease';

describe('CrossTabProbeLease', () => {
    it('sends typed claim/release runtime messages', async () => {
        const sentMessages: unknown[] = [];
        const lease = new CrossTabProbeLease({
            now: () => 1_000,
            sendMessage: async (message: unknown) => {
                sentMessages.push(message);
                const typed = message as { type: string };
                if (typed.type === 'BLACKIYA_PROBE_LEASE_CLAIM') {
                    return {
                        type: 'BLACKIYA_PROBE_LEASE_CLAIM_RESULT',
                        acquired: true,
                        ownerAttemptId: 'attempt-a',
                        expiresAtMs: 6_000,
                    };
                }
                return {
                    type: 'BLACKIYA_PROBE_LEASE_RELEASE_RESULT',
                    released: true,
                };
            },
        });

        const claim = await lease.claim('conv-1', 'attempt-a', 5_000);
        expect(claim).toEqual({
            acquired: true,
            ownerAttemptId: 'attempt-a',
            expiresAtMs: 6_000,
        });

        await lease.release('conv-1', 'attempt-a');

        expect(sentMessages[0]).toEqual({
            type: 'BLACKIYA_PROBE_LEASE_CLAIM',
            conversationId: 'conv-1',
            attemptId: 'attempt-a',
            ttlMs: 5_000,
        });
        expect(sentMessages[1]).toEqual({
            type: 'BLACKIYA_PROBE_LEASE_RELEASE',
            conversationId: 'conv-1',
            attemptId: 'attempt-a',
        });
    });

    it('fails open when claim transport fails', async () => {
        const lease = new CrossTabProbeLease({
            now: () => 2_000,
            sendMessage: async () => {
                throw new Error('runtime unavailable');
            },
        });

        const claim = await lease.claim('conv-2', 'attempt-b', 4_000);
        expect(claim).toEqual({
            acquired: true,
            ownerAttemptId: 'attempt-b',
            expiresAtMs: 6_000,
        });
    });

    it('fails open when claim response is malformed', async () => {
        const lease = new CrossTabProbeLease({
            now: () => 3_000,
            sendMessage: async () => ({
                type: 'BLACKIYA_PROBE_LEASE_CLAIM_RESULT',
                acquired: 'true',
            }),
        });

        const claim = await lease.claim('conv-3', 'attempt-c', 3_500);
        expect(claim).toEqual({
            acquired: true,
            ownerAttemptId: 'attempt-c',
            expiresAtMs: 6_500,
        });
    });
});
