import { describe, expect, it } from 'bun:test';
import {
    isProbeLeaseClaimRequest,
    isProbeLeaseClaimResponse,
    isProbeLeaseReleaseRequest,
    isProbeLeaseReleaseResponse,
} from '@/utils/sfe/probe-lease-protocol';

describe('probe-lease-protocol', () => {
    it('validates claim request shape', () => {
        expect(
            isProbeLeaseClaimRequest({
                type: 'BLACKIYA_PROBE_LEASE_CLAIM',
                conversationId: 'conv-1',
                attemptId: 'attempt-1',
                ttlMs: 5_000,
            }),
        ).toBe(true);

        expect(
            isProbeLeaseClaimRequest({
                type: 'BLACKIYA_PROBE_LEASE_CLAIM',
                conversationId: 'conv-1',
                attemptId: 'attempt-1',
            }),
        ).toBe(false);
    });

    it('validates release request shape', () => {
        expect(
            isProbeLeaseReleaseRequest({
                type: 'BLACKIYA_PROBE_LEASE_RELEASE',
                conversationId: 'conv-1',
                attemptId: 'attempt-1',
            }),
        ).toBe(true);

        expect(
            isProbeLeaseReleaseRequest({
                type: 'BLACKIYA_PROBE_LEASE_RELEASE',
                conversationId: 'conv-1',
            }),
        ).toBe(false);
    });

    it('validates claim response shape', () => {
        expect(
            isProbeLeaseClaimResponse({
                type: 'BLACKIYA_PROBE_LEASE_CLAIM_RESULT',
                acquired: true,
                ownerAttemptId: 'attempt-1',
                expiresAtMs: 5_000,
            }),
        ).toBe(true);

        expect(
            isProbeLeaseClaimResponse({
                type: 'BLACKIYA_PROBE_LEASE_CLAIM_RESULT',
                acquired: 'yes',
                ownerAttemptId: 'attempt-1',
                expiresAtMs: 5_000,
            }),
        ).toBe(false);
    });

    it('validates release response shape', () => {
        expect(
            isProbeLeaseReleaseResponse({
                type: 'BLACKIYA_PROBE_LEASE_RELEASE_RESULT',
                released: true,
            }),
        ).toBe(true);

        expect(
            isProbeLeaseReleaseResponse({
                type: 'BLACKIYA_PROBE_LEASE_RELEASE_RESULT',
                released: 'true',
            }),
        ).toBe(false);
    });
});
