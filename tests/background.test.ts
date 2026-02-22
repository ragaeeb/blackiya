import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { InMemoryLeaseStore } from '@/tests/helpers/in-memory-lease-store';
import type { ExternalConversationEvent } from '@/utils/external-api/contracts';
import type { LogEntry } from '@/utils/logs-storage';
import { ProbeLeaseCoordinator } from '@/utils/sfe/probe-lease-coordinator';

type MessageHandler = (
    message: unknown,
    sender: { tab?: { url?: string } },
    sendResponse: (response: unknown) => void,
) => boolean | undefined;

describe('background message handler', () => {
    let handlerFactory: (deps: {
        saveLog: (payload: LogEntry) => Promise<void>;
        leaseCoordinator: ProbeLeaseCoordinator;
        externalApiHub: {
            ingestEvent: (event: ExternalConversationEvent, senderTabId?: number) => Promise<void>;
        };
        logger: {
            info: (...args: unknown[]) => void;
            warn: (...args: unknown[]) => void;
            error: (...args: unknown[]) => void;
        };
    }) => MessageHandler;
    let externalMessageHandlerFactory: (deps: {
        externalApiHub: { handleExternalRequest: (request: unknown) => Promise<unknown> };
    }) => (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => true;
    let externalConnectHandlerFactory: (deps: {
        externalApiHub: { addSubscriber: (port: unknown) => boolean };
    }) => (port: unknown) => void;
    let savedLogs: unknown[];
    let now: number;

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
        };
        const mod = await import('@/entrypoints/background');
        handlerFactory = mod.createBackgroundMessageHandler as typeof handlerFactory;
        externalMessageHandlerFactory = mod.createExternalMessageHandler as typeof externalMessageHandlerFactory;
        externalConnectHandlerFactory = mod.createExternalConnectHandler as typeof externalConnectHandlerFactory;
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
            externalApiHub: {
                ingestEvent: async () => {},
            },
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
            saveLog: async (payload) => {
                savedLogs.push(payload);
            },
            leaseCoordinator: coordinator,
            externalApiHub: {
                ingestEvent: async () => {},
            },
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
            saveLog: async (payload) => {
                savedLogs.push(payload);
            },
            leaseCoordinator: coordinator,
            externalApiHub: {
                ingestEvent: async () => {},
            },
            logger: {
                info: () => {},
                warn: () => {
                    warned = true;
                },
                error: () => {},
            },
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

    it('forwards internal external-api events to hub with sender tab id', async () => {
        const coordinator = new ProbeLeaseCoordinator({
            store: new InMemoryLeaseStore(),
            now: () => now,
        });
        const seen: Array<{ event: ExternalConversationEvent; senderTabId?: number }> = [];
        const handler = handlerFactory({
            saveLog: async () => {},
            leaseCoordinator: coordinator,
            externalApiHub: {
                ingestEvent: async (event, senderTabId) => {
                    seen.push({ event, senderTabId });
                },
            },
            logger: {
                info: () => {},
                warn: () => {},
                error: () => {},
            },
        });

        const result = handler(
            {
                type: 'BLACKIYA_EXTERNAL_EVENT',
                event: {
                    api: 'blackiya.events.v1',
                    type: 'conversation.ready',
                    event_id: 'evt-1',
                    ts: 123,
                    provider: 'chatgpt',
                    conversation_id: 'conv-1',
                    payload: {
                        conversation_id: 'conv-1',
                        mapping: {},
                    },
                    capture_meta: {
                        captureSource: 'canonical_api',
                        fidelity: 'high',
                        completeness: 'complete',
                    },
                    content_hash: 'hash:1',
                },
            },
            { tab: { url: 'https://chatgpt.com/c/conv-1', id: 77 } } as any,
            () => {},
        );

        expect(result).toBeTrue();
        await flushAsyncWork();
        expect(seen).toHaveLength(1);
        expect(seen[0]?.senderTabId).toBe(77);
        expect(seen[0]?.event.conversation_id).toBe('conv-1');
    });

    it('routes external requests through the external message handler', async () => {
        const handler = externalMessageHandlerFactory({
            externalApiHub: {
                handleExternalRequest: async (request) => ({ ok: true, request }),
            },
        });

        const responses: unknown[] = [];
        const result = handler({ api: 'blackiya.events.v1', type: 'health.ping' }, {}, (response) => {
            responses.push(response);
        });

        expect(result).toBeTrue();
        await flushAsyncWork();
        expect(responses).toEqual([{ ok: true, request: { api: 'blackiya.events.v1', type: 'health.ping' } }]);
    });

    it('attaches external subscribers through the external connect handler', () => {
        const seenPorts: unknown[] = [];
        const handler = externalConnectHandlerFactory({
            externalApiHub: {
                addSubscriber: (port) => {
                    seenPorts.push(port);
                    return true;
                },
            },
        });

        const fakePort = { name: 'blackiya.events.v1' };
        handler(fakePort);
        expect(seenPorts).toEqual([fakePort]);
    });
});
