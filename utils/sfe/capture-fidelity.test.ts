import { describe, expect, it } from 'bun:test';

import {
    isDegradedCapture,
    shouldIngestAsCanonicalSample,
    shouldUseCachedConversationForWarmFetch,
} from '@/utils/sfe/capture-fidelity';

describe('capture fidelity policies', () => {
    const readyReadiness = {
        ready: true,
        terminal: true,
        reason: 'terminal',
        contentHash: 'h1',
        latestAssistantTextLength: 10,
    };

    const notReadyReadiness = {
        ready: false,
        terminal: false,
        reason: 'in-progress',
        contentHash: null,
        latestAssistantTextLength: 0,
    };

    it('detects degraded capture fidelity', () => {
        expect(isDegradedCapture(undefined)).toBe(false);
        expect(isDegradedCapture({ captureSource: 'canonical_api', fidelity: 'high', completeness: 'complete' })).toBe(
            false,
        );
        expect(
            isDegradedCapture({
                captureSource: 'dom_snapshot_degraded',
                fidelity: 'degraded',
                completeness: 'partial',
            }),
        ).toBe(true);
    });

    it('allows warm-fetch short-circuit only for ready + high-fidelity captures', () => {
        expect(
            shouldUseCachedConversationForWarmFetch(readyReadiness, {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            }),
        ).toBe(true);
        expect(
            shouldUseCachedConversationForWarmFetch(readyReadiness, {
                captureSource: 'dom_snapshot_degraded',
                fidelity: 'degraded',
                completeness: 'partial',
            }),
        ).toBe(false);
        expect(
            shouldUseCachedConversationForWarmFetch(notReadyReadiness, {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            }),
        ).toBe(false);
    });

    it('only ingests high-fidelity captures as canonical samples', () => {
        expect(
            shouldIngestAsCanonicalSample({
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            }),
        ).toBe(true);
        expect(
            shouldIngestAsCanonicalSample({
                captureSource: 'dom_snapshot_degraded',
                fidelity: 'degraded',
                completeness: 'partial',
            }),
        ).toBe(false);
    });
});
