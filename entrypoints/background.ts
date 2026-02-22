/**
 * Background Service Worker
 *
 * Handles extension lifecycle events and message passing.
 *
 * @module entrypoints/background
 */

import {
    createExternalApiHub,
    type ExternalPortLike,
    type ExternalStorageLike,
} from '@/utils/external-api/background-hub';
import { EXTERNAL_API_VERSION, isExternalInternalEventMessage } from '@/utils/external-api/contracts';
import { logger } from '@/utils/logger';
import { type LogEntry, logsStorage } from '@/utils/logs-storage';
import { ProbeLeaseCoordinator } from '@/utils/sfe/probe-lease-coordinator';
import {
    isProbeLeaseClaimRequest,
    isProbeLeaseReleaseRequest,
    type ProbeLeaseClaimResponse,
    type ProbeLeaseReleaseResponse,
} from '@/utils/sfe/probe-lease-protocol';
import { createProbeLeaseStore } from '@/utils/sfe/probe-lease-store';

type BackgroundLogger = Pick<typeof logger, 'info' | 'warn' | 'error'>;
type BackgroundSender = { tab?: { url?: string; id?: number } };

const isLogContext = (value: unknown): value is LogEntry['context'] => {
    return value === 'background' || value === 'content' || value === 'popup' || value === 'unknown';
};

const isLogEntryPayload = (payload: unknown): payload is LogEntry => {
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
};

type BackgroundMessageHandlerDeps = {
    saveLog: (payload: LogEntry) => Promise<void>;
    leaseCoordinator: ProbeLeaseCoordinator;
    externalApiHub: ReturnType<typeof createExternalApiHub>;
    logger: BackgroundLogger;
};

const handleGenericBackgroundMessage = (
    message: unknown,
    sender: BackgroundSender,
    sendResponse: (response: unknown) => void,
    loggerInstance: BackgroundLogger,
): true => {
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
};

export const createBackgroundMessageHandler = (deps: BackgroundMessageHandlerDeps) => {
    return (message: unknown, sender: BackgroundSender, sendResponse: (response: unknown) => void) => {
        if (isExternalInternalEventMessage(message)) {
            void deps.externalApiHub.ingestEvent(message.event, sender.tab?.id).catch((error) => {
                deps.logger.error('Failed to ingest external API event in background', error);
            });
            sendResponse({ success: true });
            return true;
        }

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
                    deps.logger.error('Failed to save log from content script', error);
                });
            } else {
                deps.logger.warn('Discarding malformed LOG_ENTRY payload');
            }
            return;
        }

        return handleGenericBackgroundMessage(message, sender, sendResponse, deps.logger);
    };
};

type ExternalMessageHandlerDeps = {
    externalApiHub: ReturnType<typeof createExternalApiHub>;
};

export const createExternalMessageHandler = (deps: ExternalMessageHandlerDeps) => {
    return (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => {
        void deps.externalApiHub
            .handleExternalRequest(message)
            .then((response) => {
                sendResponse(response);
            })
            .catch(() => {
                sendResponse({
                    ok: false,
                    api: EXTERNAL_API_VERSION,
                    code: 'INTERNAL_ERROR',
                    message: 'Failed to handle external API request',
                    ts: Date.now(),
                });
            });
        return true;
    };
};

type ExternalConnectHandlerDeps = {
    externalApiHub: ReturnType<typeof createExternalApiHub>;
};

export const createExternalConnectHandler = (deps: ExternalConnectHandlerDeps) => {
    return (port: ExternalPortLike) => {
        deps.externalApiHub.addSubscriber(port);
    };
};

export default defineBackground(() => {
    const leaseCoordinator = new ProbeLeaseCoordinator({
        store: createProbeLeaseStore(),
    });
    const externalApiHub = createExternalApiHub({
        storage: browser.storage.local as ExternalStorageLike,
    });
    void externalApiHub.ensureHydrated();

    logger.info('Background service worker started', {
        id: browser.runtime.id,
    });

    browser.runtime.onInstalled.addListener((details) => {
        if (details.reason === 'install') {
            logger.info('Extension installed');
        } else if (details.reason === 'update') {
            logger.info('Extension updated to version', browser.runtime.getManifest().version);
        }
    });

    browser.runtime.onMessage.addListener(
        createBackgroundMessageHandler({
            saveLog: (payload) => logsStorage.saveLog(payload),
            leaseCoordinator,
            externalApiHub,
            logger,
        }),
    );

    browser.runtime.onMessageExternal?.addListener(
        createExternalMessageHandler({
            externalApiHub,
        }),
    );

    browser.runtime.onConnectExternal?.addListener(
        createExternalConnectHandler({
            externalApiHub,
        }),
    );
});
