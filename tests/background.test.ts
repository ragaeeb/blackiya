import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { InMemoryLeaseStore } from '@/tests/helpers/in-memory-lease-store';
import { ProbeLeaseCoordinator } from '@/utils/sfe/probe-lease-coordinator';

type MessageHandler = (
    message: unknown,
    sender: { tab?: { url?: string; id?: number } },
    sendResponse: (response: unknown) => void,
) => boolean | undefined;

describe('background message handler', () => {
    let handlerFactory: (deps: any) => MessageHandler;
    let savedLogs: unknown[];
    let now: number;
    let actionCalls: Array<{ method: string; payload: unknown }>;

    const flushAsyncWork = async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    };

    const waitForResponse = async (responses: unknown[], expectedLength: number) => {
        const maxAttempts = 200;
        for (let i = 0; i < maxAttempts; i += 1) {
            if (responses.length >= expectedLength) {
                return;
            }
            await flushAsyncWork();
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error(`Timed out waiting for ${expectedLength} responses; received ${responses.length}`);
    };

    beforeAll(async () => {
        (globalThis as any).defineBackground = (factory: unknown) => factory;
        (globalThis as any).browser = {
            runtime: {
                id: 'test',
                onInstalled: { addListener: () => {} },
                onMessage: { addListener: () => {} },
                getManifest: () => ({ version: '0.0.0-test' }),
            },
            action: {
                setBadgeText: () => {},
                setBadgeBackgroundColor: () => {},
                setTitle: () => {},
            },
        };
        const mod = await import('@/entrypoints/background');
        handlerFactory = mod.createBackgroundMessageHandler as typeof handlerFactory;
    });

    beforeEach(() => {
        savedLogs = [];
        now = 1_000;
        actionCalls = [];
    });

    it('returns claim/release responses for lease messages and preserves owner-only release', async () => {
        const coordinator = new ProbeLeaseCoordinator({
            store: new InMemoryLeaseStore(),
            now: () => now,
        });
        const handler = handlerFactory({
            saveLog: async () => {},
            leaseCoordinator: coordinator,
            logger: {
                debug: () => {},
                info: () => {},
                warn: () => {},
                error: () => {},
            },
            actionApi: null,
        });

        const responses: unknown[] = [];
        const sendResponse = (value: unknown) => {
            responses.push(value);
        };

        expect(
            handler(
                {
                    type: 'BLACKIYA_PROBE_LEASE_CLAIM',
                    conversationId: 'conv-1',
                    attemptId: 'attempt-a',
                    ttlMs: 5_000,
                },
                {},
                sendResponse,
            ),
        ).toBeTrue();
        await waitForResponse(responses, 1);
        expect(responses[0]).toMatchObject({
            type: 'BLACKIYA_PROBE_LEASE_CLAIM_RESULT',
            acquired: true,
            ownerAttemptId: 'attempt-a',
        });

        expect(
            handler(
                {
                    type: 'BLACKIYA_PROBE_LEASE_CLAIM',
                    conversationId: 'conv-1',
                    attemptId: 'attempt-b',
                    ttlMs: 5_000,
                },
                {},
                sendResponse,
            ),
        ).toBeTrue();
        await waitForResponse(responses, 2);
        expect(responses[1]).toMatchObject({
            type: 'BLACKIYA_PROBE_LEASE_CLAIM_RESULT',
            acquired: false,
            ownerAttemptId: 'attempt-a',
        });

        expect(
            handler(
                {
                    type: 'BLACKIYA_PROBE_LEASE_RELEASE',
                    conversationId: 'conv-1',
                    attemptId: 'attempt-b',
                },
                {},
                sendResponse,
            ),
        ).toBeTrue();
        await waitForResponse(responses, 3);
        expect(responses[2]).toEqual({
            type: 'BLACKIYA_PROBE_LEASE_RELEASE_RESULT',
            released: false,
        });

        expect(
            handler(
                {
                    type: 'BLACKIYA_PROBE_LEASE_RELEASE',
                    conversationId: 'conv-1',
                    attemptId: 'attempt-a',
                },
                {},
                sendResponse,
            ),
        ).toBeTrue();
        await waitForResponse(responses, 4);
        expect(responses[3]).toEqual({
            type: 'BLACKIYA_PROBE_LEASE_RELEASE_RESULT',
            released: true,
        });
    });

    it('preserves existing LOG_ENTRY and PING behavior', async () => {
        const coordinator = new ProbeLeaseCoordinator({
            store: new InMemoryLeaseStore(),
            now: () => now,
        });
        const handler = handlerFactory({
            saveLog: async (payload: unknown) => {
                savedLogs.push(payload);
            },
            leaseCoordinator: coordinator,
            logger: {
                debug: () => {},
                info: () => {},
                warn: () => {},
                error: () => {},
            },
            actionApi: null,
        });

        const responses: unknown[] = [];
        const sendResponse = (value: unknown) => {
            responses.push(value);
        };

        const logResult = handler(
            {
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: new Date().toISOString(),
                    level: 'info',
                    message: 'test',
                    context: 'content',
                    data: [],
                },
            },
            {},
            sendResponse,
        );
        expect(logResult).toBeUndefined();
        await flushAsyncWork();
        expect(savedLogs).toHaveLength(1);

        const pingResult = handler({ type: 'PING' }, {}, sendResponse);
        expect(pingResult).toBeTrue();
        expect(responses).toContainEqual({ success: true, pong: true });
    });

    it('drops malformed LOG_ENTRY payloads without calling saveLog', async () => {
        const coordinator = new ProbeLeaseCoordinator({
            store: new InMemoryLeaseStore(),
            now: () => now,
        });
        let warned = false;
        const handler = handlerFactory({
            saveLog: async (payload: unknown) => {
                savedLogs.push(payload);
            },
            leaseCoordinator: coordinator,
            logger: {
                debug: () => {},
                info: () => {},
                warn: () => {
                    warned = true;
                },
                error: () => {},
            },
            actionApi: null,
        });

        const result = handler(
            {
                type: 'LOG_ENTRY',
                payload: { level: 'info', message: 'missing timestamp/context' },
            },
            {},
            () => {},
        );

        expect(result).toBeUndefined();
        await flushAsyncWork();
        expect(savedLogs).toHaveLength(0);
        expect(warned).toBeTrue();
    });

    it('updates badge progress for bulk export status messages', async () => {
        const coordinator = new ProbeLeaseCoordinator({
            store: new InMemoryLeaseStore(),
            now: () => now,
        });
        const actionApi = {
            setBadgeText: (payload: unknown) => {
                actionCalls.push({ method: 'setBadgeText', payload });
            },
            setBadgeBackgroundColor: (payload: unknown) => {
                actionCalls.push({ method: 'setBadgeBackgroundColor', payload });
            },
            setTitle: (payload: unknown) => {
                actionCalls.push({ method: 'setTitle', payload });
            },
        };
        const handler = handlerFactory({
            saveLog: async () => {},
            leaseCoordinator: coordinator,
            logger: {
                debug: () => {},
                info: () => {},
                warn: () => {},
                error: () => {},
            },
            actionApi,
        });

        const progressResult = handler(
            {
                type: 'BLACKIYA_BULK_EXPORT_PROGRESS',
                stage: 'progress',
                platform: 'ChatGPT',
                discovered: 10,
                attempted: 4,
                exported: 3,
                failed: 1,
                remaining: 6,
            },
            { tab: { id: 77 } },
            () => {},
        );
        expect(progressResult).toBeUndefined();
        expect(actionCalls).toContainEqual({
            method: 'setBadgeText',
            payload: { text: '6', tabId: 77 },
        });

        const completedResult = handler(
            {
                type: 'BLACKIYA_BULK_EXPORT_PROGRESS',
                stage: 'completed',
                platform: 'ChatGPT',
                discovered: 10,
                attempted: 10,
                exported: 10,
                failed: 0,
                remaining: 0,
            },
            { tab: { id: 77 } },
            () => {},
        );
        expect(completedResult).toBeUndefined();
        expect(actionCalls).toContainEqual({
            method: 'setBadgeText',
            payload: { text: '', tabId: 77 },
        });
    });
});
