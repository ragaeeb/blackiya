import { describe, expect, it } from 'bun:test';
import { type BlackiyaPublicStatus, createBlackiyaPublicStatusApi } from '@/entrypoints/interceptor/public-status-api';

const buildStatus = (overrides: Partial<BlackiyaPublicStatus> = {}): BlackiyaPublicStatus => ({
    platform: 'ChatGPT',
    conversationId: 'conv-1',
    attemptId: 'attempt-1',
    lifecycle: 'streaming',
    readiness: 'awaiting_stabilization',
    readinessReason: 'captured_not_ready',
    canGetJSON: false,
    canGetCommonJSON: false,
    sequence: 1,
    timestampMs: 1700000000000,
    ...overrides,
});

describe('public-status-api', () => {
    it('should emit current status immediately for status subscriptions by default', () => {
        const api = createBlackiyaPublicStatusApi(buildStatus({ lifecycle: 'idle', readiness: 'unknown' }));
        const seen: BlackiyaPublicStatus[] = [];
        const unsubscribe = api.subscribe('status', (status) => {
            seen.push(status);
        });

        expect(seen.length).toBe(1);
        expect(seen[0].lifecycle).toBe('idle');
        unsubscribe();
    });

    it('should skip immediate status emission when emitCurrent is false', () => {
        const api = createBlackiyaPublicStatusApi(buildStatus({ lifecycle: 'idle', readiness: 'unknown' }));
        const seen: BlackiyaPublicStatus[] = [];
        const unsubscribe = api.subscribe(
            'status',
            (status) => {
                seen.push(status);
            },
            { emitCurrent: false },
        );

        expect(seen.length).toBe(0);
        unsubscribe();
    });

    it('should emit ready only on rising edge and emit again after leaving ready', () => {
        const api = createBlackiyaPublicStatusApi(buildStatus());
        const seen: BlackiyaPublicStatus[] = [];
        const unsubscribe = api.subscribe(
            'ready',
            (status) => {
                seen.push(status);
            },
            { emitCurrent: false },
        );

        api.applyStatus(
            buildStatus({
                sequence: 2,
                readiness: 'canonical_ready',
                readinessReason: 'canonical_ready',
                canGetJSON: true,
                canGetCommonJSON: true,
            }),
        );
        api.applyStatus(
            buildStatus({
                sequence: 3,
                readiness: 'canonical_ready',
                readinessReason: 'canonical_ready',
                canGetJSON: true,
                canGetCommonJSON: true,
            }),
        );
        api.applyStatus(
            buildStatus({
                sequence: 4,
                readiness: 'awaiting_stabilization',
                readinessReason: 'captured_not_ready',
                canGetJSON: false,
                canGetCommonJSON: false,
            }),
        );
        api.applyStatus(
            buildStatus({
                sequence: 5,
                readiness: 'canonical_ready',
                readinessReason: 'canonical_ready',
                canGetJSON: true,
                canGetCommonJSON: true,
            }),
        );

        expect(seen.length).toBe(2);
        expect(seen[0].sequence).toBe(2);
        expect(seen[1].sequence).toBe(5);
        unsubscribe();
    });

    it('should emit current ready status immediately for late ready subscriptions', () => {
        const api = createBlackiyaPublicStatusApi(
            buildStatus({
                readiness: 'canonical_ready',
                readinessReason: 'canonical_ready',
                canGetJSON: true,
                canGetCommonJSON: true,
            }),
        );
        const seen: BlackiyaPublicStatus[] = [];

        const unsubscribe = api.subscribe('ready', (status) => {
            seen.push(status);
        });

        expect(seen.length).toBe(1);
        expect(seen[0].readiness).toBe('canonical_ready');
        unsubscribe();
    });

    it('should stop notifications after unsubscribe', () => {
        const api = createBlackiyaPublicStatusApi(buildStatus());
        const seen: BlackiyaPublicStatus[] = [];

        const unsubscribe = api.subscribe(
            'status',
            (status) => {
                seen.push(status);
            },
            { emitCurrent: false },
        );
        unsubscribe();
        api.applyStatus(buildStatus({ sequence: 2 }));

        expect(seen.length).toBe(0);
    });

    it('should notify all status subscribers even when one callback throws', () => {
        const api = createBlackiyaPublicStatusApi(buildStatus({ sequence: 1 }));
        const seenA: BlackiyaPublicStatus[] = [];
        const seenB: BlackiyaPublicStatus[] = [];

        const unsubscribeThrowing = api.subscribe(
            'status',
            () => {
                throw new Error('status subscriber failure');
            },
            { emitCurrent: false },
        );
        const unsubscribeA = api.onStatusChange(
            (status) => {
                seenA.push(status);
            },
            { emitCurrent: false },
        );
        const unsubscribeB = api.subscribe(
            'status',
            (status) => {
                seenB.push(status);
            },
            { emitCurrent: false },
        );

        api.applyStatus(buildStatus({ sequence: 2 }));

        expect(seenA.length).toBe(1);
        expect(seenB.length).toBe(1);
        expect(seenA[0].sequence).toBe(2);
        expect(seenB[0].sequence).toBe(2);

        unsubscribeThrowing();
        unsubscribeA();
        unsubscribeB();
    });

    it('should notify all ready subscribers even when one callback throws', () => {
        const api = createBlackiyaPublicStatusApi(buildStatus({ sequence: 1 }));
        const seenA: BlackiyaPublicStatus[] = [];
        const seenB: BlackiyaPublicStatus[] = [];

        const unsubscribeThrowing = api.subscribe(
            'ready',
            () => {
                throw new Error('ready subscriber failure');
            },
            { emitCurrent: false },
        );
        const unsubscribeA = api.onReady(
            (status) => {
                seenA.push(status);
            },
            { emitCurrent: false },
        );
        const unsubscribeB = api.subscribe(
            'ready',
            (status) => {
                seenB.push(status);
            },
            { emitCurrent: false },
        );

        api.applyStatus(
            buildStatus({
                sequence: 2,
                readiness: 'canonical_ready',
                readinessReason: 'canonical_ready',
                canGetJSON: true,
                canGetCommonJSON: true,
            }),
        );

        expect(seenA.length).toBe(1);
        expect(seenB.length).toBe(1);
        expect(seenA[0].sequence).toBe(2);
        expect(seenB[0].sequence).toBe(2);

        unsubscribeThrowing();
        unsubscribeA();
        unsubscribeB();
    });
});
