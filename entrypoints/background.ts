/**
 * Background Service Worker
 *
 * Handles extension lifecycle events and message passing.
 * Currently minimal as the content script handles most functionality.
 *
 * @module entrypoints/background
 */

import { logger } from '@/utils/logger';
import { type LogEntry, logsStorage } from '@/utils/logs-storage';
import { ProbeLeaseCoordinator, type ProbeLeaseCoordinatorStore } from '@/utils/sfe/probe-lease-coordinator';
import {
    isProbeLeaseClaimRequest,
    isProbeLeaseReleaseRequest,
    type ProbeLeaseClaimResponse,
    type ProbeLeaseReleaseResponse,
} from '@/utils/sfe/probe-lease-protocol';

type BackgroundLogger = Pick<typeof logger, 'info' | 'warn' | 'error'>;

class SessionStorageProbeLeaseStore implements ProbeLeaseCoordinatorStore {
    private readonly storage: typeof browser.storage.session;

    public constructor(storage: typeof browser.storage.session) {
        this.storage = storage;
    }

    public async get(key: string): Promise<string | null> {
        const result = await this.storage.get(key);
        const value = result[key];
        return typeof value === 'string' ? value : null;
    }

    public async set(key: string, value: string): Promise<void> {
        await this.storage.set({ [key]: value });
    }

    public async remove(key: string): Promise<void> {
        await this.storage.remove(key);
    }

    public async getAll(): Promise<Record<string, string>> {
        const result = await this.storage.get(null);
        const output: Record<string, string> = {};
        for (const [key, value] of Object.entries(result)) {
            if (typeof value === 'string') {
                output[key] = value;
            }
        }
        return output;
    }
}

class InMemoryProbeLeaseStore implements ProbeLeaseCoordinatorStore {
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

function createProbeLeaseStore(): ProbeLeaseCoordinatorStore {
    const sessionStorage = browser.storage?.session;
    if (sessionStorage) {
        return new SessionStorageProbeLeaseStore(sessionStorage);
    }
    return new InMemoryProbeLeaseStore();
}

function isLogContext(value: unknown): value is LogEntry['context'] {
    return value === 'background' || value === 'content' || value === 'popup' || value === 'unknown';
}

function isLogEntryPayload(payload: unknown): payload is LogEntry {
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    const candidate = payload as Partial<LogEntry>;
    if (typeof candidate.timestamp !== 'string' || typeof candidate.level !== 'string') {
        return false;
    }
    if (typeof candidate.message !== 'string' || !isLogContext(candidate.context)) {
        return false;
    }
    return candidate.data === undefined || Array.isArray(candidate.data);
}

type BackgroundMessageHandlerDeps = {
    saveLog: (payload: LogEntry) => Promise<void>;
    leaseCoordinator: ProbeLeaseCoordinator;
    logger: BackgroundLogger;
};

function handleGenericBackgroundMessage(
    message: unknown,
    sender: { tab?: { url?: string } },
    sendResponse: (response: unknown) => void,
    loggerInstance: BackgroundLogger,
): true {
    const type =
        typeof message === 'object' && message !== null && typeof (message as { type?: unknown }).type === 'string'
            ? (message as { type: string }).type
            : 'unknown';

    loggerInstance.info('Received message:', type, 'from', sender.tab?.url);

    if (type === 'PING') {
        sendResponse({ success: true, pong: true });
        return true;
    }

    loggerInstance.warn('Unknown message type:', type);
    sendResponse({ success: false, error: 'Unknown message type' });
    return true;
}

export function createBackgroundMessageHandler(deps: BackgroundMessageHandlerDeps) {
    return (message: unknown, sender: { tab?: { url?: string } }, sendResponse: (response: unknown) => void) => {
        if (isProbeLeaseClaimRequest(message)) {
            void deps.leaseCoordinator
                .claim(message.conversationId, message.attemptId, message.ttlMs)
                .then((result) => {
                    const response: ProbeLeaseClaimResponse = result;
                    sendResponse(response);
                })
                .catch((error) => {
                    deps.logger.error('Probe lease claim failed in background coordinator', error);
                    sendResponse({
                        type: 'BLACKIYA_PROBE_LEASE_CLAIM_RESULT',
                        acquired: false,
                        ownerAttemptId: null,
                        expiresAtMs: null,
                    } satisfies ProbeLeaseClaimResponse);
                });
            return true;
        }

        if (isProbeLeaseReleaseRequest(message)) {
            void deps.leaseCoordinator
                .release(message.conversationId, message.attemptId)
                .then((released) => {
                    const response: ProbeLeaseReleaseResponse = {
                        type: 'BLACKIYA_PROBE_LEASE_RELEASE_RESULT',
                        released,
                    };
                    sendResponse(response);
                })
                .catch((error) => {
                    deps.logger.error('Probe lease release failed in background coordinator', error);
                    sendResponse({
                        type: 'BLACKIYA_PROBE_LEASE_RELEASE_RESULT',
                        released: false,
                    } satisfies ProbeLeaseReleaseResponse);
                });
            return true;
        }

        if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'LOG_ENTRY') {
            const payload = (message as { payload?: unknown }).payload;
            if (isLogEntryPayload(payload)) {
                deps.saveLog(payload).catch((error) => {
                    console.error('Failed to save log from content script:', error);
                });
            } else {
                deps.logger.warn('Discarding malformed LOG_ENTRY payload');
            }
            return;
        }

        return handleGenericBackgroundMessage(message, sender, sendResponse, deps.logger);
    };
}

export default defineBackground(() => {
    const leaseCoordinator = new ProbeLeaseCoordinator({
        store: createProbeLeaseStore(),
    });

    logger.info('Background service worker started', {
        id: browser.runtime.id,
    });

    // Listen for installation/update events
    browser.runtime.onInstalled.addListener((details) => {
        if (details.reason === 'install') {
            logger.info('Extension installed');
        } else if (details.reason === 'update') {
            logger.info('Extension updated to version', browser.runtime.getManifest().version);
        }
    });

    // Message handler for future extensibility
    // Currently content script handles everything locally
    browser.runtime.onMessage.addListener(
        createBackgroundMessageHandler({
            saveLog: (payload) => logsStorage.saveLog(payload),
            leaseCoordinator,
            logger,
        }),
    );
});
