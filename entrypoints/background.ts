/**
 * Background Service Worker
 *
 * Handles extension lifecycle events and message passing.
 *
 * @module entrypoints/background
 */

import { getBuildFingerprint } from '@/utils/build-fingerprint';
import { logger } from '@/utils/logger';
import { type LogEntry, logsStorage } from '@/utils/logs-storage';
import { isBulkExportProgressMessage } from '@/utils/runner/bulk-chat-export-contract';
import { ProbeLeaseCoordinator } from '@/utils/sfe/probe-lease-coordinator';
import {
    isProbeLeaseClaimRequest,
    isProbeLeaseReleaseRequest,
    type ProbeLeaseClaimResponse,
    type ProbeLeaseReleaseResponse,
} from '@/utils/sfe/probe-lease-protocol';
import { createProbeLeaseStore } from '@/utils/sfe/probe-lease-store';

type BackgroundLogger = Pick<typeof logger, 'debug' | 'info' | 'warn' | 'error'>;
type BackgroundSender = { tab?: { url?: string; id?: number } };
type ActionApi = {
    setBadgeText: (details: { text: string; tabId?: number }) => Promise<void> | void;
    setBadgeBackgroundColor?: (details: { color: string; tabId?: number }) => Promise<void> | void;
    setTitle?: (details: { title: string; tabId?: number }) => Promise<void> | void;
};

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
    logger: BackgroundLogger;
    actionApi: ActionApi | null;
};

const toBadgeCounterText = (value: number | undefined): string => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return '';
    }
    const normalized = Math.floor(value);
    if (normalized > 999) {
        return '999+';
    }
    return String(normalized);
};

const handleBulkExportProgressMessage = (
    message: unknown,
    sender: BackgroundSender,
    deps: BackgroundMessageHandlerDeps,
): boolean => {
    if (!isBulkExportProgressMessage(message)) {
        return false;
    }
    const tabId = sender.tab?.id;
    const actionApi = deps.actionApi;
    if (!actionApi || typeof tabId !== 'number') {
        return true;
    }

    if (message.stage === 'completed') {
        void actionApi.setBadgeText({ text: '', tabId });
        void actionApi.setTitle?.({
            title: `Blackiya: Export completed (${message.exported ?? 0}/${message.attempted ?? 0})`,
            tabId,
        });
        return true;
    }

    if (message.stage === 'failed') {
        void actionApi.setBadgeText({ text: '!', tabId });
        void actionApi.setBadgeBackgroundColor?.({ color: '#b91c1c', tabId });
        void actionApi.setTitle?.({
            title: `Blackiya: Export failed${message.message ? ` - ${message.message}` : ''}`,
            tabId,
        });
        return true;
    }

    const remainingText = toBadgeCounterText(message.remaining);
    void actionApi.setBadgeText({ text: remainingText, tabId });
    void actionApi.setBadgeBackgroundColor?.({ color: '#1d4ed8', tabId });
    void actionApi.setTitle?.({
        title: `Blackiya: Exporting ${message.platform ?? 'chats'} (${message.attempted ?? 0}/${message.discovered ?? 0})`,
        tabId,
    });
    return true;
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
        if (handleBulkExportProgressMessage(message, sender, deps)) {
            return;
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
            // LOG_ENTRY is fire-and-forget and does not use sendResponse.
            return;
        }

        return handleGenericBackgroundMessage(message, sender, sendResponse, deps.logger);
    };
};

export default defineBackground(() => {
    const buildFingerprint = getBuildFingerprint();
    const leaseCoordinator = new ProbeLeaseCoordinator({
        store: createProbeLeaseStore(),
    });

    logger.info('Background service worker started', {
        id: browser.runtime.id,
        build: buildFingerprint,
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
            logger,
            actionApi: browser.action ?? null,
        }),
    );
});
