import { browser } from 'wxt/browser';
import { logger } from '@/utils/logger';
import {
    isProbeLeaseClaimResponse,
    isProbeLeaseReleaseResponse,
    type ProbeLeaseRuntimeMessage,
} from '@/utils/sfe/probe-lease-protocol';

export type ProbeLeaseClaimResult = {
    acquired: boolean;
    ownerAttemptId: string | null;
    expiresAtMs: number | null;
};

export type CrossTabProbeLeaseOptions = {
    now?: () => number;
    sendMessage?: (message: ProbeLeaseRuntimeMessage) => Promise<unknown>;
};

export class CrossTabProbeLease {
    private readonly now: () => number;
    private readonly sendMessage: (message: ProbeLeaseRuntimeMessage) => Promise<unknown>;

    public constructor(options?: CrossTabProbeLeaseOptions) {
        this.now = options?.now ?? (() => Date.now());
        this.sendMessage =
            options?.sendMessage ??
            ((message: ProbeLeaseRuntimeMessage) => {
                // WXT's runtime typing is narrower than Chrome's runtime message payloads.
                return browser.runtime.sendMessage(message as any);
            });
    }

    public async claim(conversationId: string, attemptId: string, ttlMs: number): Promise<ProbeLeaseClaimResult> {
        const message: ProbeLeaseRuntimeMessage = {
            type: 'BLACKIYA_PROBE_LEASE_CLAIM',
            conversationId,
            attemptId,
            ttlMs,
        };

        try {
            const response = await this.sendMessage(message);
            if (isProbeLeaseClaimResponse(response)) {
                return {
                    acquired: response.acquired,
                    ownerAttemptId: response.ownerAttemptId,
                    expiresAtMs: response.expiresAtMs,
                };
            }
            logger.warn('Probe lease claim returned malformed response; failing open', {
                conversationId,
                attemptId,
            });
        } catch (error) {
            logger.warn('Probe lease claim transport failed; failing open', {
                conversationId,
                attemptId,
                error: error instanceof Error ? error.message : String(error),
            });
        }

        return this.failOpenClaim(attemptId, ttlMs);
    }

    public async release(conversationId: string, attemptId: string) {
        const message: ProbeLeaseRuntimeMessage = {
            type: 'BLACKIYA_PROBE_LEASE_RELEASE',
            conversationId,
            attemptId,
        };

        try {
            const response = await this.sendMessage(message);
            if (!isProbeLeaseReleaseResponse(response)) {
                logger.warn('Probe lease release returned malformed response', {
                    conversationId,
                    attemptId,
                });
            }
        } catch (error) {
            logger.warn('Probe lease release transport failed', {
                conversationId,
                attemptId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    public dispose() {
        // Reserved for future abort/signal cleanup hooks.
    }

    private failOpenClaim(attemptId: string, ttlMs: number): ProbeLeaseClaimResult {
        return {
            acquired: true,
            ownerAttemptId: attemptId,
            expiresAtMs: this.now() + Math.max(ttlMs, 1),
        };
    }
}
