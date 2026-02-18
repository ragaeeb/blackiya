import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ProbeLeaseCoordinator } from '@/utils/sfe/probe-lease-coordinator';

type MessageHandler = (
    message: unknown,
    sender: { tab?: { url?: string } },
    sendResponse: (response: unknown) => void,
) => boolean | undefined;

class InMemoryLeaseStore {
    private readonly entries = new Map<string, string>();

    public async get(key: string): Promise<string | null> {
        return this.entries.get(key) ?? null;
    }

    public async set(key: string, value: string): Promise<void> {
        this.entries.set(key, value);
    }

    public async remove(key: string): Promise<void> {
        this.entries.delete(key);
    }

    public async getAll(): Promise<Record<string, string>> {
        return Object.fromEntries(this.entries.entries());
    }
}

describe('background message handler', () => {
    let handlerFactory: (deps: {
        saveLog: (payload: unknown) => Promise<void>;
        leaseCoordinator: ProbeLeaseCoordinator;
        logger: {
            info: (...args: unknown[]) => void;
            warn: (...args: unknown[]) => void;
            error: (...args: unknown[]) => void;
        };
    }) => MessageHandler;
    let savedLogs: unknown[];
    let now: number;

    async function flushAsyncWork(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    async function waitForResponse(responses: unknown[], expectedLength: number): Promise<void> {
        const maxAttempts = 50;
        for (let i = 0; i < maxAttempts; i += 1) {
            if (responses.length >= expectedLength) {
                return;
            }
            await flushAsyncWork();
        }
    }

    beforeAll(async () => {
        (globalThis as any).defineBackground = (factory: unknown) => factory;
        (globalThis as any).browser = {
            runtime: {
                id: 'test',
                onInstalled: { addListener: () => {} },
                onMessage: { addListener: () => {} },
                getManifest: () => ({ version: '0.0.0-test' }),
            },
        };
        const mod = await import('@/entrypoints/background');
        handlerFactory = mod.createBackgroundMessageHandler as typeof handlerFactory;
    });

    beforeEach(() => {
        savedLogs = [];
        now = 1_000;
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
                info: () => {},
                warn: () => {},
                error: () => {},
            },
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
        ).toBe(true);
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
        ).toBe(true);
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
        ).toBe(true);
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
        ).toBe(true);
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
            saveLog: async (payload) => {
                savedLogs.push(payload);
            },
            leaseCoordinator: coordinator,
            logger: {
                info: () => {},
                warn: () => {},
                error: () => {},
            },
        });

        const responses: unknown[] = [];
        const sendResponse = (value: unknown) => {
            responses.push(value);
        };

        const logResult = handler(
            {
                type: 'LOG_ENTRY',
                payload: { level: 'info', message: 'test' },
            },
            {},
            sendResponse,
        );
        expect(logResult).toBeUndefined();
        await flushAsyncWork();
        expect(savedLogs).toHaveLength(1);

        const pingResult = handler({ type: 'PING' }, {}, sendResponse);
        expect(pingResult).toBe(true);
        expect(responses).toContainEqual({ success: true, pong: true });
    });
});
